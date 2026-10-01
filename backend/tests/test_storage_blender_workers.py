"""Blender workers started by the rig transfer, the animal rig and the material split: what environment they get, and
that none runs without a receipt that names it."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path as LocalPath
import subprocess
from types import SimpleNamespace

import pytest

from api.test_characters import rigged_glb
from src.services import animal_production, avatar_rig_transfer, character_parts
from src.services.animal_production import AnimalProduction, StepPaused
from src.services.asset_editor import _write_json
from src.services.avatar_factory import digest
from src.services.avatar_rig_transfer import AvatarRigTransfer
from src.services.character_pipeline import PipelineError, read_json
from src.services.object_storage import StoredPath
from src.services.process_identity import identity

SECRETS = {'OPENAI_API_KEY', 'MESHY_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'CHARACTER_DATABASE_URL', 'JWT_SECRET'}
JOB = 'a' * 24


class FakeProcess:
    """A Blender that is this very test process, so that identity() can read it."""

    def __init__(self, command, exit_code, hangs, **kwargs):
        self.command, self.kwargs, self.exit_code, self.hangs = command, kwargs, exit_code, hangs
        self.pid = os.getpid()
        self.calls = []

    def wait(self, timeout=None):
        if self.hangs and not self.calls:
            raise subprocess.TimeoutExpired(self.command, timeout)
        return self.exit_code

    def terminate(self):
        self.calls.append('terminate')

    def kill(self):
        self.calls.append('kill')


@pytest.fixture
def blender(monkeypatch):
    """subprocess.Popen replaced by a fake worker; set `exit_code` or `hangs` before the run."""
    state = SimpleNamespace(processes=[], exit_code=0, hangs=False)

    def popen(command, **kwargs):
        state.processes.append(FakeProcess(command, state.exit_code, state.hangs, **kwargs))
        return state.processes[-1]

    monkeypatch.setattr(subprocess, 'Popen', popen)
    for name in SECRETS:
        monkeypatch.setenv(name, f'secret-{name}')
    return state


def assert_scrubbed(process):
    environment = process.kwargs['env']
    assert not [name for name in environment if name.upper() in SECRETS]
    assert environment['ASSET_STORAGE_WORKER_LOCAL'] == '1'
    # What Blender needs to start is still there.
    assert environment['PATH'] == os.environ['PATH']


def assert_receipt(path):
    assert read_json(path)['process']['pid'] == os.getpid()


def failing_write(module, monkeypatch, name='runner.json'):
    """`_write_json` of `module` fails for the file `name`, as a full disk or a lost connection would."""
    write = module._write_json

    def write_json(path, value):
        if path.name == name:
            raise OSError('disk full')
        return write(path, value)

    monkeypatch.setattr(module, '_write_json', write_json)


# --- rig transfer ---------------------------------------------------------------------------------

@pytest.fixture
def transfer(tmp_path, monkeypatch, blender):
    root = StoredPath(tmp_path) / 'avatar-factory'
    factory = SimpleNamespace(root=root, get=lambda owner, job_id: {'id': job_id},
                              directory=lambda owner, job_id: root / str(owner) / job_id)
    monkeypatch.setattr(avatar_rig_transfer, 'blender_executable', lambda: 'blender')
    request = 'r' * 24
    rig = root / '1' / JOB / 'meshy' / 'rig-transfer'
    work = rig / request
    work.mkdir(parents=True)
    here = StoredPath(avatar_rig_transfer.__file__)
    _write_json(work / 'input.json', {'body': str(tmp_path / 'body.glb'), 'donor': str(tmp_path / 'donor.glb'),
                                      'output': str(work), 'body_sha256': 'b' * 64, 'donor_sha256': 'd' * 64,
                                      'worker_sha256': digest(here.with_name('avatar_rig_transfer_blender.py')),
                                      'binding_sha256': digest(here.with_name('avatar_blender_common.py'))})
    _write_json(work / 'record.json', {'id': request, 'status': 'accepted', 'source_job_id': 'b' * 24, 'source_version': 'v'})
    _write_json(rig / 'current.json', {'id': request})
    return AvatarRigTransfer(factory), work, request


def test_rig_transfer_worker_gets_no_credentials_and_a_receipt(transfer, blender):
    service, work, request = transfer
    service.execute(1, JOB, request)
    (process,) = blender.processes
    assert_scrubbed(process)
    assert_receipt(work / 'runner.json')
    # No seal came back from the fake: the run is paused, not complete.
    assert read_json(work / 'record.json')['status'] == 'paused'


def test_rig_transfer_stops_a_worker_it_cannot_record(transfer, blender, monkeypatch):
    service, work, request = transfer
    failing_write(avatar_rig_transfer, monkeypatch)
    service.execute(1, JOB, request)
    (process,) = blender.processes
    assert process.calls == ['terminate']
    assert not (work / 'runner.json').is_file()
    record = read_json(work / 'record.json')
    assert record['status'] == 'paused' and record['error_type'] == 'OSError'


def test_rig_transfer_still_stops_a_worker_that_outlives_its_time(transfer, blender):
    service, work, request = transfer
    blender.hangs = True
    service.execute(1, JOB, request)
    assert blender.processes[0].calls == ['terminate']
    assert read_json(work / 'record.json')['error_type'] == 'TimeoutExpired'


# --- animal rig -----------------------------------------------------------------------------------

@pytest.fixture
def animal(tmp_path, monkeypatch, blender):
    production = AnimalProduction(SimpleNamespace(root=StoredPath(tmp_path) / 'avatar-factory'), 1)
    animal_id = 'c' * 24
    model = b'glTF model bytes'
    sha = hashlib.sha256(model).hexdigest()
    directory = production.library.directory(animal_id)
    (directory / 'files').mkdir(parents=True)
    (directory / 'files' / f'{sha}.glb').write_bytes(model)
    _write_json(directory / 'record.json', {'id': animal_id, 'files': {'model.glb': sha}, 'stages': {}})
    work = directory / 'jobs' / ('d' * 24)
    (work / 'rig').mkdir(parents=True)
    monkeypatch.setattr(animal_production, 'blender_executable', lambda: 'blender')
    return production, animal_id, work


def test_animal_rig_worker_gets_no_credentials_and_leaves_a_receipt(animal, blender):
    production, animal_id, work = animal
    blender.exit_code = 1
    with pytest.raises(PipelineError) as failed:
        production._rig(animal_id, work, {})
    assert failed.value.code == 'rig_failed'
    (process,) = blender.processes
    assert_scrubbed(process)
    assert_receipt(work / 'rig' / 'runner.json')
    assert process.command[0] == 'blender' and process.command[-1].endswith('input.json')


def test_animal_rig_stops_a_worker_it_cannot_record(animal, blender, monkeypatch):
    production, animal_id, work = animal
    failing_write(animal_production, monkeypatch)
    with pytest.raises(OSError, match='disk full'):
        production._rig(animal_id, work, {})
    assert blender.processes[0].calls == ['terminate']
    assert not (work / 'rig' / 'runner.json').is_file()


def test_animal_rig_keeps_stopping_a_worker_that_outlives_its_time(animal, blender):
    production, animal_id, work = animal
    blender.hangs = True
    with pytest.raises(StepPaused, match='시간이 초과'):
        production._rig(animal_id, work, {})
    assert blender.processes[0].calls == ['terminate']
    # It was recorded as well: a restart can tell what it was.
    assert_receipt(work / 'rig' / 'runner.json')


def test_animal_rig_does_not_start_a_second_worker_beside_a_live_one(animal, blender):
    production, animal_id, work = animal
    _write_json(work / 'rig' / 'runner.json', {'process': identity()})
    with pytest.raises(StepPaused, match='이전 Blender'):
        production._rig(animal_id, work, {})
    assert blender.processes == []
    # A receipt of a worker that is gone does not stand in the way.
    _write_json(work / 'rig' / 'runner.json', {'process': {'pid': os.getpid(), 'created_at': 1.5}})
    blender.exit_code = 1
    with pytest.raises(PipelineError):
        production._rig(animal_id, work, {})
    assert len(blender.processes) == 1


# --- material split -------------------------------------------------------------------------------

@pytest.fixture
def split(tmp_path, monkeypatch, blender):
    monkeypatch.setattr(character_parts, 'blender_executable', lambda: 'blender')
    model = LocalPath(tmp_path) / 'model.glb'
    model.write_bytes(rigged_glb())
    return model, LocalPath(tmp_path) / 'out'


def test_material_split_worker_gets_no_credentials_and_a_receipt(split, blender):
    model, output = split
    blender.exit_code = 1
    with pytest.raises(ValueError, match='separation failed'):
        character_parts.separate_materials(model, output)
    (process,) = blender.processes
    assert_scrubbed(process)
    assert_receipt(output / 'runner.json')
    assert json.loads((output / 'runner.json').read_text(encoding='utf-8'))['source_sha256'] == hashlib.sha256(model.read_bytes()).hexdigest()


def test_material_split_stops_a_worker_it_cannot_record(split, blender, monkeypatch):
    model, output = split
    failing_write(character_parts, monkeypatch)
    with pytest.raises(OSError, match='disk full'):
        character_parts.separate_materials(model, output)
    assert blender.processes[0].calls == ['terminate']
    assert not (output / 'runner.json').exists()


def test_material_split_still_kills_a_worker_that_outlives_its_time(split, blender):
    model, output = split
    blender.hangs = True
    with pytest.raises(ValueError, match='timed out'):
        character_parts.separate_materials(model, output)
    assert blender.processes[0].calls == ['kill']
