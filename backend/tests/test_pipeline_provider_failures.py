"""A paid 3D task that cannot be polled or downloaded must pause the job, never strand it and never be sent again.

The world is the one of test_avatar_image_pipeline (fake OpenAI images, one MockTransport for Meshy and its CDN).
"""
from collections import Counter
import threading

import httpx
import pytest

from src.services import avatar_image_pipeline as module
from src.services import avatar_meshy, character_jobs, provider_http, run_lock
from src.services.asset_editor import _write_json
from src.services.avatar_stage_resume import AvatarStageResume
from src.services.character_jobs import download as real_download
from src.services.character_pipeline import PipelineError, read_json
from src.services.process_identity import identity
from test_avatar_image_pipeline import PART_COUNT, setup  # noqa: F401  (the fixture)

MODEL_URL = 'https://fixture.invalid/model.glb'


@pytest.fixture
def world(setup, monkeypatch):  # noqa: F811
    service, factory, payload, calls, transport, client_type = setup
    # The rig stage is not under test; the job stops once its parts are made.
    monkeypatch.setattr(avatar_meshy.AvatarMeshy, 'start', lambda self, owner, job: None)
    monkeypatch.setattr(avatar_meshy.AvatarMeshy, 'execute', lambda self, owner, job: None)
    waited = []
    monkeypatch.setattr(provider_http, '_sleep', waited.append)

    def use(handler):
        monkeypatch.setattr(module.httpx, 'Client',
                            lambda **kwargs: client_type(**kwargs, transport=httpx.MockTransport(handler)))
    use(transport)
    job, _ = service.create(1, 'pipeline-provider-failure', {**payload, 'production_mode': 'character_parts',
                                                            'slots': module.CHARACTER_PART_SLOTS})
    return service, factory, job['id'], calls, transport, use, waited


def stopped(factory, job_id):
    return factory.get(1, job_id)


def is_poll(request):
    return request.method == 'GET' and '/image-to-3d/' in request.url.path


def test_a_provider_that_stays_down_pauses_the_job_without_a_new_paid_request(world):
    service, factory, job_id, calls, transport, use, waited = world
    down = True

    def handler(request):
        if is_poll(request) and down:
            return httpx.Response(503)
        return transport(request)
    use(handler)
    service.execute(1, job_id, poll_seconds=0)
    paused = stopped(factory, job_id)
    assert paused['status'] == 'pipeline_paused'
    assert 'Meshy' in paused['error'] and '그대로' in paused['error'] and '성공 여부' not in paused['error']
    assert read_json(factory.directory(1, job_id)/'failure.json')['code'] == 'provider_poll_failed'
    assert paused['interrupted']['stage'] == 'models' and paused['interrupted']['at']
    assert waited == [1, 2, 4] and len(calls['posts']) == PART_COUNT
    # The provider is back: continuing only polls the tasks it already accepted.
    down = False
    service.resume(1, job_id, stage='models')
    service.execute(1, job_id, poll_seconds=0)
    assert len(calls['posts']) == PART_COUNT
    done = stopped(factory, job_id)
    assert done['status'] == 'review_required' and all(part['model_status'] == 'ready' for part in done['parts'])
    assert 'interrupted' not in done


def test_one_busy_answer_while_polling_costs_nothing(world):
    service, factory, job_id, calls, transport, use, waited = world
    answers = iter([503, 503])

    def handler(request):
        if is_poll(request):
            status = next(answers, 200)
            if status != 200:
                return httpx.Response(status)
        return transport(request)
    use(handler)
    service.execute(1, job_id, poll_seconds=0)
    assert stopped(factory, job_id)['status'] == 'review_required'
    assert waited == [1, 2] and len(calls['posts']) == PART_COUNT


def test_a_refused_poll_is_reported_as_the_provider_refusal_it_is(world):
    service, factory, job_id, calls, transport, use, waited = world
    use(lambda request: httpx.Response(401, json={'message': 'bad key'}) if is_poll(request) else transport(request))
    service.execute(1, job_id, poll_seconds=0)
    paused = stopped(factory, job_id)
    assert paused['status'] == 'pipeline_paused' and 'HTTP 401' in paused['error'] and waited == []
    assert 'interrupted' not in paused


def test_a_refused_model_download_pauses_the_job_and_names_the_status(world, monkeypatch):
    service, factory, job_id, calls, transport, use, waited = world
    monkeypatch.setattr(character_jobs, 'download', real_download)

    def handler(request):
        if str(request.url) == MODEL_URL:
            # Streamed, so the body was never read: asking it for text raises ResponseNotRead.
            return httpx.Response(403, stream=httpx.ByteStream(b'expired'))
        return transport(request)
    use(handler)
    service.execute(1, job_id, poll_seconds=0)
    paused = stopped(factory, job_id)
    assert paused['status'] == 'pipeline_paused' and 'HTTP 403' in paused['error']
    assert read_json(factory.directory(1, job_id)/'failure.json')['code'] == 'download_failed'
    assert paused['interrupted']['stage'] == 'models' and len(calls['posts']) == PART_COUNT
    # Not stuck: the job can be continued at once, and the saved task is polled again, not submitted again.
    assert service.resume(1, job_id, stage='models')['status'] == 'pipeline_queued'


def status_error(code, body=None):
    request = httpx.Request('GET', 'https://api.meshy.ai/openapi/v1/multi-image-to-3d/task')
    return httpx.HTTPStatusError('provider refused', request=request,
                                 response=httpx.Response(code, stream=httpx.ByteStream(body or b'{}'), request=request))


def test_an_unread_error_answer_cannot_stop_the_pause_from_being_written(world, monkeypatch):
    service, factory, job_id, calls, transport, use, waited = world

    def refused(directory, stage):
        raise status_error(403)
    monkeypatch.setattr(character_jobs, 'download', refused)
    service.execute(1, job_id, poll_seconds=0)
    paused = stopped(factory, job_id)
    assert paused['status'] == 'pipeline_paused' and 'HTTP 403' in paused['error']
    # Nobody holds the job: the stage can be continued.
    assert service.resume(1, job_id, stage='models')['status'] == 'pipeline_queued'


def test_a_message_that_cannot_be_built_still_pauses_the_job(world, monkeypatch):
    service, factory, job_id, calls, transport, use, waited = world

    def refused(directory, stage):
        raise status_error(403)

    def broken(*args):
        raise RuntimeError('cannot describe the answer')
    monkeypatch.setattr(character_jobs, 'download', refused)
    monkeypatch.setattr(module, '_provider_http_message', broken)
    service.execute(1, job_id, poll_seconds=0)
    paused = stopped(factory, job_id)
    assert paused['status'] == 'pipeline_paused' and 'HTTPStatusError' in paused['error'] and '자동으로 보내지 않습니다' in paused['error']


def test_a_failure_record_that_cannot_be_saved_still_pauses_the_job(world, monkeypatch):
    service, factory, job_id, calls, transport, use, waited = world
    real = module._write_json

    def write(path, value):
        if path.name == 'failure.json':
            raise OSError('storage unavailable')
        return real(path, value)

    def refused(directory, stage):
        raise status_error(403)
    monkeypatch.setattr(character_jobs, 'download', refused)
    monkeypatch.setattr(module, '_write_json', write)
    service.execute(1, job_id, poll_seconds=0)
    assert stopped(factory, job_id)['status'] == 'pipeline_paused'


def test_an_unread_answer_text_is_empty_instead_of_raising():
    assert module._body_text(httpx.Response(403, stream=httpx.ByteStream(b'x'))) == ''
    assert module._body_text(httpx.Response(403, content=b'read')) == 'read'


# --- the Meshy library and the recovery of a lost task ID are asked without the global lock -----------------------

def lock_is_held_by_caller():
    """True when the thread that is running holds the factory's lock: another thread cannot take it."""
    result = []

    def try_to_take():
        taken = module._LOCK.acquire(timeout=0.5)
        result.append(taken)
        if taken:
            module._LOCK.release()
    probe = threading.Thread(target=try_to_take)
    probe.start(), probe.join()
    return not result[0]


def test_a_new_job_reads_the_meshy_library_outside_the_lock(setup, monkeypatch):  # noqa: F811
    service, factory, payload, calls, transport, client_type = setup
    held = []

    def handler(request):
        held.append((request.url.path, lock_is_held_by_caller()))
        return transport(request)
    monkeypatch.setattr(module.httpx, 'Client', lambda **kwargs: client_type(**kwargs, transport=httpx.MockTransport(handler)))
    service.create(1, 'pipeline-library-outside-lock', {**payload, 'production_mode': 'character_parts',
                                                       'slots': module.CHARACTER_PART_SLOTS})
    assert any(path.endswith('/animations/library') for path, _ in held)
    assert not [path for path, locked in held if locked]


def test_a_replayed_request_asks_meshy_nothing(setup, monkeypatch):  # noqa: F811
    service, factory, payload, calls, transport, client_type = setup
    asked = []

    def handler(request):
        asked.append(request.url.path)
        return transport(request)
    monkeypatch.setattr(module.httpx, 'Client', lambda **kwargs: client_type(**kwargs, transport=httpx.MockTransport(handler)))
    request = {**payload, 'production_mode': 'character_parts', 'slots': module.CHARACTER_PART_SLOTS}
    first, created = service.create(1, 'pipeline-replayed-request', request)
    assert created and asked
    (factory.root/'1'/'meshy-library.json').unlink()
    asked.clear()
    again, created = service.create(1, 'pipeline-replayed-request', request)
    assert not created and again['id'] == first['id'] and asked == []


def paused_with_lost_submission(factory, job_id, slot='top'):
    directory = factory.directory(1, job_id)
    job = read_json(directory/'job.json')
    _write_json(directory/'job.json', {**job, 'status': 'pipeline_paused'})
    run = directory/'parts'/slot
    run.mkdir(parents=True, exist_ok=True)
    _write_json(run/'character.json', {'stage': 'generation', 'status': 'submission_uncertain',
                                       'generation_endpoint': '/openapi/v1/multi-image-to-3d'})
    return directory, run


def test_recovering_a_lost_task_asks_the_provider_outside_the_lock(world):
    service, factory, job_id, calls, transport, use, waited = world
    directory, run = paused_with_lost_submission(factory, job_id)
    held = []

    def handler(request):
        held.append(lock_is_held_by_caller())
        return httpx.Response(200, json={'status': 'SUCCEEDED', 'progress': 100})
    use(handler)
    recovered = service.recover_task(1, job_id, 'top', 'recovered-task-1')
    assert held == [False]
    saved = read_json(run/'character.json')
    assert saved['task_id'] == 'recovered-task-1' and saved['status'] == 'SUCCEEDED' and saved['recovered_by'] == 1
    assert next(part for part in recovered['parts'] if part['slot'] == 'top')['task_id'] == 'recovered-task-1'
    assert (run/'generation-result.json').is_file()


def test_a_recovery_is_dropped_when_the_job_moved_on_while_the_provider_answered(world):
    service, factory, job_id, calls, transport, use, waited = world
    directory, run = paused_with_lost_submission(factory, job_id)

    def handler(request):
        # A resume lands while the provider is being asked.
        _write_json(directory/'job.json', {**read_json(directory/'job.json'), 'status': 'pipeline_queued'})
        return httpx.Response(200, json={'status': 'SUCCEEDED', 'progress': 100})
    use(handler)
    with pytest.raises(PipelineError) as error:
        service.recover_task(1, job_id, 'top', 'recovered-task-1')
    assert error.value.code == 'invalid_state'
    saved = read_json(run/'character.json')
    assert saved['status'] == 'submission_uncertain' and 'task_id' not in saved
    assert not (run/'generation-result.json').exists()


def test_a_task_the_provider_does_not_know_is_still_a_lookup_error(world):
    service, factory, job_id, calls, transport, use, waited = world
    paused_with_lost_submission(factory, job_id)
    use(lambda request: httpx.Response(404, json={'message': 'unknown'}))
    with pytest.raises(PipelineError) as error:
        service.recover_task(1, job_id, 'top', 'unknown-task')
    assert error.value.code == 'task_lookup_failed' and error.value.status == 422


# --- polling a provider writes only what changed --------------------------------------------------------------------

def test_a_poll_that_changes_nothing_writes_nothing(world, monkeypatch):
    service, factory, job_id, calls, transport, use, waited = world
    polls, events = Counter(), []

    def handler(request):
        if is_poll(request):
            polls[request.url.path] += 1
            events.append(('poll', polls[request.url.path]))
            if polls[request.url.path] <= 3:
                return httpx.Response(200, json={'status': 'IN_PROGRESS', 'progress': 40})
        return transport(request)
    use(handler)

    def counted(module_, name):
        real = getattr(module_, name)
        monkeypatch.setattr(module_, name, lambda path, value: (events.append(('write', path.name)), real(path, value))[1])
    counted(module, '_write_json')
    counted(module, 'update_json')
    counted(character_jobs, '_write_json')
    service.execute(1, job_id, poll_seconds=0)
    assert stopped(factory, job_id)['status'] == 'review_required' and len(calls['posts']) == PART_COUNT
    # The second and third polls of every part found the same task: the job records, the receipts and the progress
    # were written by the first poll and are not written again.
    second = events.index(('poll', 2))
    fourth = events.index(('poll', 4))
    assert events[second:fourth] == [('poll', 2)] * PART_COUNT + [('poll', 3)] * PART_COUNT
    assert ('write', 'progress.json') in events[:second] and ('write', 'job.json') in events[fourth:]


# --- a task the provider accepted is never sent again, even when its ID was not saved ------------------------------

def accepted_without_a_saved_id(world, monkeypatch):
    """(the top part's run, its task ID): Meshy accepted the top part, and its task ID never reached storage."""
    service, factory, job_id, calls, transport, use, waited = world
    monkeypatch.setattr(run_lock, 'FINAL_WRITE_DELAYS', (0, 0))
    real = character_jobs._write_json

    def write(path, value):
        if path.name == 'character.json' and path.parent.name == 'top' and value.get('task_id'):
            raise OSError('storage unavailable')
        return real(path, value)
    monkeypatch.setattr(character_jobs, '_write_json', write)
    service.execute(1, job_id, poll_seconds=0)
    monkeypatch.setattr(character_jobs, '_write_json', real)
    run = factory.directory(1, job_id)/'parts'/'top'
    lost = read_json(run/'character.json')
    assert lost['status'] == 'submission_uncertain' and 'task_id' not in lost
    assert stopped(factory, job_id)['status'] == 'pipeline_paused'
    return run, f'fixture-task-{len(calls["posts"])}'


def test_a_part_whose_task_id_could_not_be_saved_is_polled_and_never_sent_again(world, monkeypatch):
    service, factory, job_id, calls, transport, use, waited = world
    run, accepted = accepted_without_a_saved_id(world, monkeypatch)
    # An explicit run sends unaccepted parts again; the saved answer shows this one was accepted.
    service.resume(1, job_id, stage='models', retry_failed=True)
    service.execute(1, job_id, poll_seconds=0)
    saved = read_json(run/'character.json')
    assert saved['task_id'] == accepted and saved['recovery_method'] == 'submission_response'
    assert len(calls['posts']) == PART_COUNT and stopped(factory, job_id)['status'] == 'review_required'
    assert not (run/'attempts').exists()


def test_a_part_whose_saved_answer_names_its_task_is_offered_as_recoverable_without_a_resend(world, monkeypatch):
    service, factory, job_id, calls, transport, use, waited = world
    run, accepted = accepted_without_a_saved_id(world, monkeypatch)
    # The saved answer names the accepted task: resuming polls it, so resume is open and no re-send is offered.
    public = factory.get(1, job_id)
    assert next(action for action in public['next_actions'] if action['id'] == 'resume')['enabled']
    stages = AvatarStageResume(factory).get(1, job_id)
    assert not [action for action in stages['actions'] if action.get('warning')]
    assert next(action for action in stages['actions'] if action['stage'] == 'models')['enabled']
    # A GET only reads: the receipt is recorded under its task by the run that continues it.
    assert read_json(run/'character.json')['status'] == 'submission_uncertain'


# --- workers whose last save failed do not hold the stages -------------------------------------------------------------

def test_the_stages_are_open_when_the_rig_and_assembly_workers_are_gone(world):
    service, factory, job_id, calls, transport, use, waited = world
    service.execute(1, job_id, poll_seconds=0)
    assert stopped(factory, job_id)['status'] == 'review_required'
    directory = factory.directory(1, job_id)
    version = 'c' * 24
    (directory/'native-parts'/version).mkdir(parents=True)
    _write_json(directory/'native-parts/current.json', {'version': version})
    # Saved as running by this live process, whose workers ended without their last save.
    _write_json(directory/'native-parts'/version/'record.json', {'status': 'running', 'process': identity()})
    (directory/'meshy').mkdir(exist_ok=True)
    _write_json(directory/'meshy/worker.json', {'status': 'running', 'process': identity()})
    stages = AvatarStageResume(factory).get(1, job_id)
    assert stages['busy'] is False
    assert next(action for action in stages['actions'] if action['stage'] == 'rig')['enabled']
    assert factory.get(1, job_id)['character_flow']['busy'] is False
    assert avatar_meshy._WORKERS.acquire(str(directory/'meshy'))
    try:
        assert AvatarStageResume(factory).get(1, job_id)['busy'] is True
    finally:
        avatar_meshy._WORKERS.release(str(directory/'meshy'))
