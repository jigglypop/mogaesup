"""Stage runs whose saves fail: a run that cannot be saved as running or as finished never keeps every stage busy."""
import json
from types import SimpleNamespace

import pytest

from src.services import avatar_stage_resume as stages, run_lock
from src.services.character_pipeline import read_json
from src.services.object_storage import StoredPath
from src.services.process_identity import identity


@pytest.fixture
def job(tmp_path, monkeypatch):
    monkeypatch.setattr(run_lock, 'FINAL_WRITE_DELAYS', (0, 0))
    directory = StoredPath(tmp_path / 'job')
    (directory / 'stage-runs').mkdir(parents=True)
    (directory / 'stage-runs' / 'current.json').write_text(json.dumps({'id': 'r1'}))
    factory = SimpleNamespace(directory=lambda owner, job_id: directory)
    return directory, factory


def save_run(directory, **record):
    (directory / 'stage-runs' / 'r1.json').write_text(json.dumps({'id': 'r1', 'stage': 'rig', **record}))


def test_a_run_of_this_process_is_active_only_while_its_worker_holds_the_lock(job):
    directory, _ = job
    save_run(directory, status='running', process=identity())
    assert stages.stage_run_active(directory)[1] is False
    assert stages._WORKERS.acquire(str(directory))
    try:
        assert stages.stage_run_active(directory)[1] is True
    finally:
        stages._WORKERS.release(str(directory))
    # Accepted work waits for its worker and stays active.
    save_run(directory, status='accepted', process=identity())
    assert stages.stage_run_active(directory)[1] is True


def test_a_run_that_cannot_be_saved_as_running_is_paused_instead_of_left_accepted(job, monkeypatch):
    directory, factory = job
    save_run(directory, status='accepted', process=identity())
    write = stages._write_json
    attempts = []

    def refuse_running(path, record):
        if record.get('status') == 'running':
            attempts.append(1)
            raise OSError('storage unavailable')
        return write(path, record)

    monkeypatch.setattr(stages, '_write_json', refuse_running)
    with pytest.raises(OSError):
        stages.AvatarStageResume(factory).execute(1, 'a' * 24, 'r1')
    record = read_json(directory / 'stage-runs' / 'r1.json')
    assert attempts == [1] and record['status'] == 'paused' and record['error']
    assert stages.stage_run_active(directory)[1] is False and stages._WORKERS == {}


def stale_worker_records(directory):
    """An assembly, a rig worker and a stage run all saved as running by this live process, whose workers are gone:
    what a failed last save leaves behind."""
    version = 'b' * 24
    for name in ('native-parts/' + version, 'meshy'):
        (directory / name).mkdir(parents=True)
    (directory / 'native-parts' / 'current.json').write_text(json.dumps({'version': version}))
    (directory / 'native-parts' / version / 'record.json').write_text(json.dumps({'status': 'running', 'process': identity()}))
    (directory / 'meshy' / 'worker.json').write_text(json.dumps({'status': 'running', 'process': identity()}))
    save_run(directory, status='running', process=identity())
    return directory / 'native-parts' / version


def flow(directory):
    from src.services.avatar_character_flow import character_flow
    job = {'status': 'review_required', 'progress': {'stage': 'rig', 'message': ''}, 'next_actions': [], 'error': None}
    return character_flow(directory, job), job['next_actions']


def test_workers_whose_last_save_failed_do_not_keep_the_job_running(job):
    from src.services import avatar_meshy, avatar_native_parts
    directory, _ = job
    assembly = stale_worker_records(directory)
    state, actions = flow(directory)
    # Nothing runs them any more: the job can be resumed instead of reading as running until a restart.
    assert state['busy'] is False and state['status'] == 'paused' and actions[0]['enabled']
    for workers, key in ((avatar_native_parts._WORKERS, str(assembly)), (avatar_meshy._WORKERS, str(directory / 'meshy')),
                         (stages._WORKERS, str(directory))):
        assert workers.acquire(key)
        try:
            state, actions = flow(directory)
            assert state['busy'] is True and state['status'] == 'running'
            assert not any(action['enabled'] for action in actions)
        finally:
            workers.release(key)


def admission(job, monkeypatch, changes):
    """A stage service whose stages are computed without the process lock; the first `changes` computations see another
    writer change the job meanwhile."""
    from src.services.avatar_factory import _LOCK
    directory, factory = job
    (directory / 'stage-runs' / 'current.json').unlink()
    (directory / 'job.json').write_text(json.dumps({'status': 'review_required'}))
    service = stages.AvatarStageResume(factory)
    computed = []

    def get(owner, job_id):
        computed.append(_LOCK._is_owned())
        if len(computed) <= changes:
            (directory / 'job.json').write_text(json.dumps({'status': 'review_required', 'updated_at': len(computed)}))
        return {'actions': [{'stage': 'assemble', 'enabled': True, 'reason': None, 'paid': False}]}
    monkeypatch.setattr(service, 'get', get)
    return service, computed


def test_a_stage_is_computed_without_the_process_lock_and_admitted_on_the_records_it_read(job, monkeypatch):
    directory, _ = job
    service, computed = admission(job, monkeypatch, changes=1)
    state, request_id = service.start(1, 'a' * 24, 'assemble', 'stage-key-0001')
    # Computed twice (the job changed under the first), then read back once admitted: never under the lock.
    assert request_id and computed == [False, False, False]
    assert read_json(directory / 'stage-runs' / f'{request_id}.json')['status'] == 'accepted'
    assert read_json(directory / 'stage-runs' / 'current.json') == {'id': request_id}
    # The same key again is a replay.
    assert service.start(1, 'a' * 24, 'assemble', 'stage-key-0001')[1] is None


def test_a_job_that_keeps_changing_is_refused_instead_of_admitted_on_old_reads(job, monkeypatch):
    directory, _ = job
    service, computed = admission(job, monkeypatch, changes=3)
    with pytest.raises(stages.PipelineError) as error:
        service.start(1, 'a' * 24, 'assemble', 'stage-key-0002')
    assert error.value.code == 'stage_changed' and not any(computed)
    assert not (directory / 'stage-runs' / 'current.json').exists()


# --- what an assembly costs: the default expressions it makes ---------------------------------------------------------

def expressions(*statuses):
    items = [{'name': f'e{index}', 'status': status, 'applied': status == 'complete'} for index, status in enumerate(statuses)]
    return {'status': 'complete' if all(item['applied'] for item in items) else 'pending', 'items': items}


@pytest.mark.parametrize('made, paid', [
    (expressions('pending', 'complete'), True),
    (expressions('paused'), True),
    (expressions('complete', 'complete'), False),
    # A refused or unconfirmed request is never sent again by an assembly; only an explicit expressions run does.
    (expressions('blocked'), False),
    (None, False),
])
def test_a_rig_recovery_says_whether_the_assembly_it_hands_over_to_is_paid(tmp_path, monkeypatch, made, paid):
    from src.services import avatar_rig_transfer
    directory = StoredPath(tmp_path / 'job')
    (directory / 'meshy').mkdir(parents=True)
    job = {'production_mode': 'character_parts', 'default_expressions': made}
    factory = SimpleNamespace(get=lambda owner, job_id: job, directory=lambda owner, job_id: directory)
    monkeypatch.setattr(avatar_rig_transfer, 'blender_executable', lambda: 'blender')
    assert stages.assembly_paid(directory, job) is paid
    assert avatar_rig_transfer.AvatarRigTransfer(factory).get(1, 'a' * 24)['paid'] is paid
