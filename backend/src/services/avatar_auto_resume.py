"""Continue factory stages stopped by a server restart.

Off unless ASSET_AUTO_RESUME opts in, and started only by the scan at startup (repeated once admission reopens when it
met a drain): a resume can send paid requests that were never attempted, so no GET may trigger one. Only stages whose
executor process has exited are resumed, through the same admitted stage runs as the UI. An unconfirmed paid request is never replayed:
its stage stays unavailable until the operator retries that request.
"""
from datetime import datetime, timedelta, timezone
import hashlib
import logging
import os
import re
import sys
import threading
import time

from src.services.character_pipeline import PipelineError, read_json
from src.services.object_storage import child_names
from src.services.process_identity import state as process_state
from src.services.runtime_activity import RuntimeDraining, draining, running_task

LOGGER = logging.getLogger(__name__)
RECENT = timedelta(hours=6)
_scheduled = set()
_guard = threading.Lock()
_waiting = None  # The factory whose scan met a drain, scanned again once admission reopens.


def opted_in():
    return os.getenv('ASSET_AUTO_RESUME', '').strip().lower() in ('1', 'true', 'yes')


def enabled():
    return opted_in() and 'pytest' not in sys.modules


def _recent(value):
    try:
        moment = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - moment <= RECENT


def _stopped(record):
    return record.get('status') in ('accepted', 'running') and process_state(record.get('process')) == 'exited'


def interrupted_stage(factory, owner, job_id):
    """(stage, marker) left unfinished by an exited process, or None."""
    from src.services.avatar_stage_resume import current_run
    directory = factory.directory(owner, job_id)
    job = read_json(directory/'job.json')
    if job.get('production_mode') != 'character_parts':
        return None
    run = current_run(directory)
    if _stopped(run) and _recent(run.get('updated_at')):
        return run['stage'], f'run:{run["id"]}'
    interrupted = job.get('interrupted') or {}
    if (job.get('status') == 'pipeline_paused' and interrupted.get('stage') in ('images', 'models')
            and _recent(interrupted.get('at'))):
        return interrupted['stage'], f'job:{interrupted["at"]}'
    pointer = read_json(directory/'native-parts/current.json')
    native = read_json(directory/'native-parts'/pointer['version']/'record.json') if pointer else {}
    if _stopped(native) and _recent(native.get('created_at')):
        return 'assemble', f'native:{pointer["version"]}:{native.get("created_at")}'
    worker = read_json(directory/'meshy/worker.json')
    if _stopped(worker) and worker.get('origin') != 'rig_transfer' and _recent(job.get('updated_at')):
        process = worker.get('process') or {}
        return 'rig', f'rig:{process.get("pid")}:{process.get("created_at")}'
    expressions = read_json(directory/'default-expressions.json')
    if (expressions.get('status') == 'running' and process_state(expressions.get('process')) == 'exited'
            and _recent(expressions.get('updated_at'))):
        return 'expressions', f'expressions:{expressions.get("updated_at")}'
    return None


def resume(factory, owner, job_id):
    from src.services.avatar_stage_resume import AvatarStageResume
    found = interrupted_stage(factory, owner, job_id)
    if not found:
        return False
    stage, marker = found
    # One admitted run per interruption: a replayed key never starts the stage again.
    key = 'auto-' + hashlib.sha256(f'{job_id}:{stage}:{marker}'.encode()).hexdigest()[:40]
    service = AvatarStageResume(factory)
    try:
        _, request_id = service.start(owner, job_id, stage, key, explicit=False)
    except PipelineError as exc:
        LOGGER.info('Auto resume skipped job=%s stage=%s code=%s', job_id, stage, exc.code)
        return False
    if not request_id:
        return False
    LOGGER.info('Auto resume job=%s stage=%s', job_id, stage)
    service.execute(owner, job_id, request_id)
    return True


def schedule(factory, owner, job_id):
    """Resume one job in the background, once at a time."""
    if not enabled():
        return
    key = (int(owner), job_id)
    with _guard:
        if key in _scheduled:
            return
        _scheduled.add(key)

    def run():
        admitted = refused = False
        try:
            time.sleep(2)  # Let the request that noticed the stop finish first.
            with running_task():
                admitted = True
                resume(factory, owner, job_id)
        except Exception as exc:
            refused = isinstance(exc, RuntimeDraining) and not admitted
            if refused:
                # Nothing started; the scan after the drain finds this stop again.
                LOGGER.info('Auto resume waits for admission job=%s', job_id)
            else:
                LOGGER.exception('Auto resume stopped job=%s', job_id)
        finally:
            with _guard:
                _scheduled.discard(key)
        if refused:
            _wait_for_admission(factory)

    threading.Thread(target=run, name=f'auto-resume-{job_id[:8]}', daemon=True).start()


def _scan(factory):
    time.sleep(5)
    if draining():
        # A deployment starts this server with admission closed; nothing could be admitted until it reopens.
        _wait_for_admission(factory)
        return
    for owner in child_names(factory.root):
        if not owner.isdigit():
            continue
        for job_id in child_names(factory.root/owner):
            if not re.fullmatch(r'[a-f0-9]{24}', job_id):
                continue
            try:
                factory.get(int(owner), job_id)  # Marks jobs whose executor exited.
                if interrupted_stage(factory, int(owner), job_id):
                    schedule(factory, int(owner), job_id)
            except PipelineError as exc:
                if exc.code != 'not_found':
                    LOGGER.info('Auto resume scan skipped job=%s code=%s', job_id, exc.code)
            except Exception:
                LOGGER.exception('Auto resume scan skipped job=%s', job_id)


def _start_scan(factory):
    threading.Thread(target=lambda: _scan(factory), name='auto-resume-scan', daemon=True).start()


def start(factory):
    """Scan once after startup for stages stopped with the previous server."""
    if not enabled():
        return
    _start_scan(factory)


def _wait_for_admission(factory):
    global _waiting
    with _guard:
        _waiting = factory
    # The drain may have been resumed after the refusal and before the line above, with no one left to call reopened().
    if not draining():
        reopened()


def reopened():
    """Called once a drain is resumed: repeat a scan that met it. It is the startup scan itself, with the same
    one-run-per-interruption keys, so it resumes nothing the startup scan would not have."""
    global _waiting
    with _guard:
        factory, _waiting = _waiting, None
    if factory is not None:
        LOGGER.info('Auto resume scans again after admission reopened')
        _start_scan(factory)
