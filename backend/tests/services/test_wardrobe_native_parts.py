import os

import pytest

from lock_probe import lock_free
from native_assembly_fixture import JOB, VERSION, seed_native_assembly
from services.test_native_hair_upload import native_fixture
from src.services import avatar_native_parts, avatar_variants, native_hair_upload
from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.avatar_glb_bodies import AvatarGlbBodies
from src.services.avatar_native_parts import AvatarNativeParts, workspace_inputs
from src.services.character_pipeline import PipelineError, read_json
from wardrobe_fixture import OWNER, Library

BODY, BODY_VERSION = 'b' * 24, '1' * 24
SLOTS = ('hair', 'hat', 'top', 'bottom', 'shoes')


@pytest.fixture
def refit(tmp_path, monkeypatch):
    """A sealed part job on a registered body, ready for a refit of its hair; Blender is a stand-in name."""
    factory, directory = seed_native_assembly(tmp_path, 'fixture')
    library = Library(tmp_path, factory)
    library.job(BODY)
    library.assembly(BODY, BODY_VERSION, slots=())
    library.current(BODY, BODY_VERSION)
    library.register((BODY, BODY_VERSION))
    job = read_json(directory.parent.parent/'job.json')
    (directory.parent.parent/'output/generated-hair.glb').write_bytes(b'raw hair model')
    job.update(base_job_id=BODY, base_version=BODY_VERSION, requested_slots=['hair'],
               files={**job['files'], 'generated-hair.glb': digest(directory.parent.parent/'output/generated-hair.glb')})
    _write_json(directory.parent.parent/'job.json', job)
    _write_json(directory.parent.parent/'pipeline.json', {'hair_length': 'source', 'parts': [{'slot': slot} for slot in ('body', *SLOTS)]})
    # Receipts live in a directory that only a local disk needs to exist.
    (directory.parent/'refit-requests').mkdir()
    monkeypatch.setattr(avatar_native_parts, 'blender_executable', lambda: 'blender')
    return library, AvatarNativeParts(factory), directory.parent


def offered(library):
    return [(version, sha) for job, version, _, sha in library.listed(BODY) if job == JOB]


def test_accepting_a_refit_keeps_the_sealed_version_offered_until_the_refit_is_sealed(refit):
    library, native, root = refit
    sealed = read_json(root/VERSION/'record.json')['files']['hair.glb']
    assert offered(library) == [(VERSION, sealed)]
    state, created = native.start_refit(OWNER, JOB, VERSION, 'hair', 'refit-key-0001')
    assert created and state['status'] == 'accepted' and state['version'] != VERSION
    assert read_json(root/'current.json')['version'] == state['version']
    assert read_json(root/'ready.json') == {'version': VERSION}
    assert offered(library) == [(VERSION, sealed)]
    # The refit fails: nothing changes for the members.
    record = read_json(root/state['version']/'record.json')
    _write_json(root/state['version']/'record.json', {**record, 'status': 'failed', 'files': {}, 'result': {}})
    assert offered(library) == [(VERSION, sealed)]
    # Sealed: the new version is the one offered, with its own hash.
    _write_json(root/state['version']/'record.json', {**record, 'status': 'review_required',
                'files': {'hair.glb': 'c' * 64, 'body.glb': 'd' * 64}, 'result': {'parts': [{'slot': 'hair'}]}})
    assert offered(library) == [(state['version'], 'c' * 64)]


class FakeProcess:
    pid = os.getpid()

    def __init__(self, exit_code=1):
        self.exit_code, self.stopped = exit_code, []
        self.completed = False

    def wait(self, timeout=None):
        self.completed, self.timeout = True, timeout
        return self.exit_code

    def poll(self):
        return self.exit_code if self.completed else None

    def terminate(self):
        self.stopped.append('terminate')

    def kill(self):
        self.stopped.append('kill')


def launches(monkeypatch, module, process):
    started = []

    def popen(command, **kwargs):
        started.append(kwargs)
        return process
    monkeypatch.setattr(module.subprocess, 'Popen', popen)
    return started


def secrets(monkeypatch):
    for name, value in {'OPENAI_API_KEY': 'k1', 'MESHY_API_KEY': 'k2', 'AWS_SECRET_ACCESS_KEY': 's',
                        'CHARACTER_DATABASE_URL': 'postgresql://user:pw@host/db', 'JWT_SECRET': 'j'}.items():
        monkeypatch.setenv(name, value)


def test_blender_assembly_starts_without_provider_keys_or_database_url(refit, monkeypatch):
    library, native, root = refit
    secrets(monkeypatch)
    state, _ = native.start_refit(OWNER, JOB, VERSION, 'hair', 'refit-key-0001')
    started = launches(monkeypatch, avatar_native_parts, FakeProcess())
    native.execute(OWNER, JOB)
    [env] = [call['env'] for call in started]
    assert env['ASSET_STORAGE_WORKER_LOCAL'] == '1'
    assert not {'OPENAI_API_KEY', 'MESHY_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'CHARACTER_DATABASE_URL', 'JWT_SECRET'} & set(env)
    assert read_json(root/state['version']/'record.json')['status'] == 'failed'


def test_a_worker_whose_receipt_cannot_be_written_is_stopped(refit, monkeypatch):
    library, native, root = refit
    state, _ = native.start_refit(OWNER, JOB, VERSION, 'hair', 'refit-key-0001')
    process = FakeProcess()
    launches(monkeypatch, avatar_native_parts, process)
    real = avatar_native_parts._write_json

    def write(path, value):
        if path.name == 'runner.json':
            raise OSError('storage unavailable')
        return real(path, value)
    monkeypatch.setattr(avatar_native_parts, '_write_json', write)
    native.execute(OWNER, JOB)
    assert process.stopped == ['terminate']
    record = read_json(root/state['version']/'record.json')
    assert record['status'] == 'failed' and record['error_stage'] == 'blender'


def test_the_body_reference_worker_gets_no_credentials_and_is_stopped_without_its_receipt(tmp_path, monkeypatch):
    secrets(monkeypatch)
    monkeypatch.setattr(avatar_variants, 'blender_executable', lambda: 'blender')
    output = tmp_path/'body-reference'
    output.mkdir()
    process = FakeProcess(exit_code=0)
    started = launches(monkeypatch, avatar_variants, process)
    avatar_variants.render_body_reference(output, tmp_path/'worker.py')
    # Three views at up to three minutes each on the studio's two vCPUs.
    assert process.timeout == avatar_variants.BODY_RENDER_TIMEOUT >= 3*180
    env = started[0]['env']
    assert env['ASSET_STORAGE_WORKER_LOCAL'] == '1'
    assert not {'OPENAI_API_KEY', 'MESHY_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'CHARACTER_DATABASE_URL', 'JWT_SECRET'} & set(env)
    real = avatar_variants._write_json

    def write(path, value):
        if path.name == 'runner.json':
            raise OSError('storage unavailable')
        return real(path, value)
    monkeypatch.setattr(avatar_variants, '_write_json', write)
    process = FakeProcess(exit_code=0)
    launches(monkeypatch, avatar_variants, process)
    with pytest.raises(OSError):
        avatar_variants.render_body_reference(output, tmp_path/'worker.py')
    assert process.stopped == ['terminate']


def test_the_drawings_of_a_worn_hat_are_inputs_of_the_blender_workspace():
    payload = {'source': 'job/native-parts/v0/body.glb',
               'parts': [{'slot': 'hat', 'path': 'job/output/generated-hat.glb', 'part_method': 'worn',
                          'drawings': {'front': 'job/output/hat-front.png', 'side': 'job/output/hat-side.png'},
                          'drawing_sha256': {'front': 'a', 'side': 'b'}},
                         {'slot': 'hair', 'path': 'job/output/generated-hair.glb', 'part_method': 'worn',
                          'drawings': {'front': 'job/output/hair-front.png'},
                          'image_paths': {'front': 'job/output/hair-front.png', 'back': 'job/output/hair-back.png'},
                          'fallback_path': 'job/native-parts/v0/hair.glb'}],
               'prefit_parts': [{'slot': 'top', 'path': 'job/prefit-parts/top.glb'}]}
    inputs = workspace_inputs(payload)
    assert {'job/output/hat-front.png', 'job/output/hat-side.png'} <= set(inputs)
    assert inputs == ['job/native-parts/v0/body.glb', 'job/output/generated-hat.glb', 'job/output/generated-hair.glb',
                      'job/prefit-parts/top.glb', 'job/output/hair-front.png', 'job/output/hair-back.png',
                      'job/output/hat-front.png', 'job/output/hat-side.png', 'job/native-parts/v0/hair.glb']


def test_the_assembly_answer_names_files_never_where_the_worker_kept_them(refit):
    """Records sealed before the worker cut its paths still answer without them; the artifact URLs keep theirs."""
    import json
    library, native, root = refit
    path = root/VERSION/'record.json'
    record = read_json(path)
    failed = {'slot': 'hat', 'available': False, 'fit_status': 'failed', 'objects': [],
              'errors': [{'code': 'fit_exception',
                          'message': r'ValueError: C:\Users\someone\AppData\Local\Temp\tmp1\hat.glb broke at /srv/data/jobs/x/hat.blend'}],
              'measurement': {'silhouette_registration': {'views': {
                  'front': {'source': '/srv/data/avatar-factory/1/job/output/hat-front.png', 'error': r'OSError: \\nas\share\hat.png'}}}}}
    record['result']['parts'] = [failed if part['slot'] == 'hat' else part for part in record['result']['parts']]
    record['result']['incomplete_parts'] = [{'slot': 'hat', 'status': 'failed', 'errors': failed['errors'], 'available': False}]
    _write_json(path, record)
    state = native.get(OWNER, JOB)
    text = json.dumps(state, ensure_ascii=False)
    for leaked in ('Users', 'someone', 'Temp', '/srv/', 'nas', 'share'):
        assert leaked not in text, leaked
    hat = next(part for part in state['parts'] if part['slot'] == 'hat')
    assert hat['errors'][0]['message'] == 'ValueError: hat.glb broke at hat.blend'
    assert hat['measurement']['silhouette_registration']['views']['front'] == {'source': 'hat-front.png', 'error': 'OSError: hat.png'}
    assert state['incomplete_parts'][0]['errors'][0]['message'] == 'ValueError: hat.glb broke at hat.blend'
    assert all(item['url'].startswith(f'/api/avatar-factory/jobs/{JOB}/native-parts/{VERSION}/') for item in state['artifacts'])
    # The record itself is left as it was sealed.
    assert read_json(path)['result']['parts'] == record['result']['parts']


def uploaded_hair(native, root, monkeypatch, validate):
    """The job's hair is an owner's rigged upload, checked by `validate` in place of the native hair validator."""
    job = root.parent
    content = native_fixture()
    asset = AvatarGlbBodies(native.factory).upload(OWNER, content)
    (job/'output/generated-hair.glb').write_bytes(content)
    record = read_json(job/'job.json')
    _write_json(job/'job.json', {**record, 'files': {**record['files'], 'generated-hair.glb': asset['id']}})
    pipeline = read_json(job/'pipeline.json')
    pipeline['parts'][1]['provenance'] = {'origin': 'uploaded_glb', 'asset_id': asset['id']}
    _write_json(job/'pipeline.json', pipeline)
    monkeypatch.setattr(native_hair_upload, 'validate_native_hair', validate)
    return asset['id']


def test_an_uploaded_hair_is_validated_and_every_input_hashed_while_the_process_lock_is_free(
        refit, monkeypatch, storage_configured):
    library, native, root = refit
    validated, hashed = [], []
    asset = uploaded_hair(native, root, monkeypatch,
                          lambda content, **kwargs: (validated.append(lock_free()), {'budget_met': True})[1])
    monkeypatch.setattr(avatar_native_parts, 'digest', lambda path: (hashed.append(_LOCK._is_owned()), digest(path))[1])
    state, created = native.start_refit(OWNER, JOB, VERSION, 'hair', 'refit-key-0001')
    assert created and validated == [True]
    assert hashed and not any(hashed)
    contract = read_json(root/state['version']/'input.json')['contract']
    assert contract['uploaded_native_hair'] == {'hair': {'sha256': asset, 'native_hair_budget': {'budget_met': True}}}


def test_a_pipeline_written_while_the_inputs_are_read_is_kept_and_the_inputs_read_again(refit, monkeypatch, storage_configured):
    library, native, root = refit
    calls = []

    def validate(content, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            pipeline = read_json(root.parent/'pipeline.json')
            _write_json(root.parent/'pipeline.json', {**pipeline, 'note': 'written meanwhile'})
        return {'budget_met': True}
    uploaded_hair(native, root, monkeypatch, validate)
    state, created = native.start_refit(OWNER, JOB, VERSION, 'hair', 'refit-key-0001')
    assert created and len(calls) == 2
    pipeline = read_json(root.parent/'pipeline.json')
    assert pipeline['note'] == 'written meanwhile' and pipeline['local_refit']['target_version'] == state['version']
    assert read_json(root/'current.json') == {'version': state['version']}


def test_a_pipeline_that_keeps_changing_admits_nothing_and_the_request_can_be_sent_again(refit, monkeypatch, storage_configured):
    library, native, root = refit
    calls = []

    def validate(content, **kwargs):
        calls.append(1)
        pipeline = read_json(root.parent/'pipeline.json')
        _write_json(root.parent/'pipeline.json', {**pipeline, 'note': len(calls)})
        return {'budget_met': True}
    uploaded_hair(native, root, monkeypatch, validate)
    with pytest.raises(PipelineError) as error:
        native.start_refit(OWNER, JOB, VERSION, 'hair', 'refit-key-0001')
    assert error.value.code == 'base_changed' and error.value.status == 409 and len(calls) == 3
    assert read_json(root/'current.json') == {'version': VERSION}
    assert 'target_version' not in read_json(root.parent/'pipeline.json')['local_refit']
    monkeypatch.setattr(native_hair_upload, 'validate_native_hair', lambda content, **kwargs: {'budget_met': True})
    state, created = native.start_refit(OWNER, JOB, VERSION, 'hair', 'refit-key-0001')
    assert created and read_json(root/'current.json') == {'version': state['version']}


def test_the_stage_check_runs_under_the_process_lock_before_anything_is_written(refit):
    library, native, root = refit
    checked = []

    def admit():
        checked.append(_LOCK._is_owned())
        raise PipelineError('stage_running', '선택한 단계가 실행 중입니다.', 409)
    pipeline = read_json(root.parent/'pipeline.json')
    with pytest.raises(PipelineError) as error:
        native.start_refit(OWNER, JOB, VERSION, 'hair', 'refit-key-0001', admit=admit)
    assert error.value.code == 'stage_running' and checked == [True]
    assert read_json(root.parent/'pipeline.json') == pipeline and not list((root/'refit-requests').iterdir())


def test_a_refit_whose_base_was_moved_while_its_parts_were_copied_is_refused(refit, monkeypatch):
    library, native, root = refit
    pipeline = read_json(root.parent/'pipeline.json')
    real = avatar_native_parts.copy_file

    def copy(source, target):
        _write_json(root/'current.json', {'version': 'd' * 24})
        return real(source, target)
    monkeypatch.setattr(avatar_native_parts, 'copy_file', copy)
    with pytest.raises(PipelineError) as error:
        native.start_refit(OWNER, JOB, VERSION, 'hair', 'refit-key-0001')
    assert error.value.code == 'base_changed'
    assert read_json(root.parent/'pipeline.json') == pipeline and not list((root/'refit-requests').iterdir())


def test_a_resumed_version_is_answered_once_the_process_lock_is_released(refit, monkeypatch):
    library, native, root = refit
    state, created = native.start_refit(OWNER, JOB, VERSION, 'hair', 'refit-key-0001')
    held, real_get = [], AvatarNativeParts.get
    monkeypatch.setattr(AvatarNativeParts, 'get',
                        lambda self, *args, **kwargs: (held.append(_LOCK._is_owned()), real_get(self, *args, **kwargs))[1])
    again, created_again = native.start_refit(OWNER, JOB, VERSION, 'hair', 'refit-key-0001')
    assert created and not created_again and again['version'] == state['version']
    assert held and not any(held)


def test_an_assembly_file_is_found_from_the_job_record_alone(refit, monkeypatch):
    library, native, root = refit
    monkeypatch.setattr(native.factory, 'get', lambda *args: pytest.fail('reading a file must not read the whole job'))
    assert native.artifact(OWNER, JOB, VERSION, 'hair.glb') == root/VERSION/'hair.glb'
    assert native.get(OWNER, JOB)['version'] == VERSION
    # Every check stays: the owner, the name, the sealed hash.
    for owner, name in ((2, 'hair.glb'), (OWNER, 'missing.glb'), (OWNER, '../hair.glb')):
        with pytest.raises(PipelineError) as error:
            native.artifact(owner, JOB, VERSION, name)
        assert error.value.status == 404
    # Two files of one version read its record once when the caller holds it.
    record = read_json(root/VERSION/'record.json')
    reads, real_read = [], avatar_native_parts.read_json
    monkeypatch.setattr(avatar_native_parts, 'read_json', lambda path, *args: (reads.append(path.name), real_read(path, *args))[1])
    native.artifact(OWNER, JOB, VERSION, 'hair.glb', record=record)
    native.artifact(OWNER, JOB, VERSION, 'body.glb', record=record)
    assert 'record.json' not in reads
    (root/VERSION/'hair.glb').write_bytes(b'changed')
    with pytest.raises(PipelineError) as changed:
        native.artifact(OWNER, JOB, VERSION, 'hair.glb', record=record)
    assert changed.value.code == 'artifact_changed'
