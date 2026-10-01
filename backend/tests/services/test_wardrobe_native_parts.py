import os

import pytest

from native_assembly_fixture import JOB, VERSION, seed_native_assembly
from src.services import avatar_native_parts, avatar_variants
from src.services.asset_editor import _write_json
from src.services.avatar_factory import digest
from src.services.avatar_native_parts import AvatarNativeParts, workspace_inputs
from src.services.character_pipeline import read_json
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

    def wait(self, timeout=None):
        return self.exit_code

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
