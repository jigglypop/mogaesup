"""Stage runs whose saves fail: a run that cannot be saved as running or as finished, or whose admission answer is
lost, never keeps every stage busy; and a stopped run never hides where newer saved records place the job."""
import hashlib
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


def flow(directory, **saved):
    from src.services.avatar_character_flow import character_flow
    job = {'status': 'review_required', 'progress': {'stage': 'rig', 'message': ''}, 'next_actions': [], 'error': None,
           **saved}
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


BEFORE, STOPPED, AFTER = '2026-10-11T01:00:00+00:00', '2026-10-11T02:00:00+00:00', '2026-10-11T03:00:00+00:00'


def assembly(directory, version, **record):
    (directory / 'native-parts' / version).mkdir(parents=True)
    (directory / 'native-parts' / 'current.json').write_text(json.dumps({'version': version}))
    (directory / 'native-parts' / version / 'record.json').write_text(json.dumps(record))


@pytest.mark.parametrize('stage', ['models', 'rig', 'assemble'])
def test_a_run_stopped_by_the_faces_of_the_assembly_it_sealed_leaves_the_character_finished(job, stage):
    directory, _ = job
    assembly(directory, 'b' * 24, status='review_required', created_at=BEFORE)
    error = 'smile: 표정 이미지 생성 실패'
    save_run(directory, stage=stage, status='paused', error=error, updated_at=STOPPED)
    faces = {'status': 'paused', 'busy': False, 'error': error, 'completed': 4, 'total': 5}
    state, _ = flow(directory, default_expressions=faces, updated_at=BEFORE)
    # The plain assembly is used while a face is missing: the character stays with the finished ones.
    assert (state['stage'], state['status'], state['message']) == ('expressions', 'paused', error)


def test_a_sealed_assembly_with_parts_to_refit_is_not_finished_by_a_stopped_expressions_run(job):
    directory, _ = job
    assembly(directory, 'b' * 24, status='review_required', created_at=BEFORE,
             result={'incomplete_parts': [{'slot': 'top', 'status': 'needs_anchors'}]})
    save_run(directory, stage='expressions', status='paused', error='smile: 표정 이미지 생성 실패', updated_at=STOPPED)
    faces = {'status': 'paused', 'busy': False, 'error': 'smile: 표정 이미지 생성 실패', 'completed': 4, 'total': 5}
    state, _ = flow(directory, default_expressions=faces, updated_at=BEFORE)
    assert (state['stage'], state['message']) == ('assemble', '상의 피팅 기준점 보정 필요')


def test_a_stopped_run_gives_way_to_work_saved_after_it_or_past_its_stage(job):
    directory, _ = job
    (directory / 'meshy').mkdir()
    save_run(directory, stage='rig', status='paused', error='저장된 3D 파츠가 없거나 변경되었습니다.', updated_at=STOPPED)
    # Nothing saved since: where the operator's run stopped, with its error.
    state, _ = flow(directory, updated_at=BEFORE)
    assert (state['stage'], state['status'], state['message']) == ('rig', 'paused', '저장된 3D 파츠가 없거나 변경되었습니다.')
    # Images requested again since then stopped at their own stage.
    state, _ = flow(directory, status='pipeline_paused', progress={'stage': 'images', 'message': ''}, error='정면 이미지 실패',
                    updated_at=AFTER)
    assert (state['stage'], state['message']) == ('images', '정면 이미지 실패')
    # The rig was received since: the job waits at the assembly.
    (directory / 'meshy' / 'worker.json').write_text(json.dumps({'status': 'complete', 'error': None}))
    state, _ = flow(directory, updated_at=BEFORE)
    assert (state['stage'], state['message']) == ('assemble', '저장된 작업에서 이어가기 대기')
    # An assembly started after an assembly run stopped (a refit) reports its own failure.
    save_run(directory, stage='assemble', status='paused', error='일부 파츠 피팅 보정 필요', updated_at=STOPPED)
    assembly(directory, 'c' * 24, status='failed', error='Blender 조립 중단', created_at=AFTER)
    state, _ = flow(directory, updated_at=BEFORE)
    assert (state['stage'], state['message']) == ('assemble', 'Blender 조립 중단')


def test_an_admitted_run_is_returned_to_be_run_even_when_its_state_cannot_be_read_again(job, monkeypatch):
    directory, factory = job
    reads = []

    def get(self, owner, job_id):
        reads.append(job_id)
        if len(reads) == 2:  # The read after admission.
            raise OSError('storage unavailable')
        return {'actions': [{'stage': 'assemble', 'enabled': True}], 'busy': False}

    monkeypatch.setattr(stages.AvatarStageResume, 'get', get)
    service = stages.AvatarStageResume(factory)
    _, request_id = service.start(1, 'a' * 24, 'assemble', 'assemble-run-1')
    assert request_id and read_json(directory / 'stage-runs' / f'{request_id}.json')['status'] == 'accepted'
    # The same request sent again after its answer was lost returns it as well while nothing has run it.
    assert service.start(1, 'a' * 24, 'assemble', 'assemble-run-1')[1] == request_id
    ran = []
    monkeypatch.setattr(stages, 'publish_saved_models', lambda directory, pipeline: ran.append('publish'))
    from src.services import avatar_character_flow
    monkeypatch.setattr(avatar_character_flow, 'assemble_character', lambda factory, owner, job_id: ran.append('assemble'))
    for _ in range(2):  # Both answers scheduled it: it runs once.
        service.execute(1, 'a' * 24, request_id)
    assert ran == ['publish', 'assemble'] and read_json(directory / 'stage-runs' / f'{request_id}.json')['status'] == 'paused'
    assert service.start(1, 'a' * 24, 'assemble', 'assemble-run-1')[1] is None


def test_a_replay_returns_only_the_current_run_this_process_admitted_and_nothing_took(job, monkeypatch):
    directory, factory = job
    monkeypatch.setattr(stages.AvatarStageResume, 'get', lambda self, owner, job_id: {'actions': [], 'busy': True})
    service = stages.AvatarStageResume(factory)
    request_id = hashlib.sha256(b'assemble-run-1').hexdigest()

    def admitted(current=request_id, **record):
        (directory / 'stage-runs' / 'current.json').write_text(json.dumps({'id': current}))
        (directory / 'stage-runs' / f'{request_id}.json').write_text(json.dumps(
            {'id': request_id, 'stage': 'assemble', 'status': 'accepted', 'process': identity(), **record}))
        return service.start(1, 'a' * 24, 'assemble', 'assemble-run-1')[1]

    assert admitted() == request_id
    # Another process admitted it, a worker took it, or a later run replaced it.
    assert admitted(process={'pid': 1, 'created_at': 0.0}) is None
    assert admitted(status='running') is None
    assert admitted(current='r1') is None
