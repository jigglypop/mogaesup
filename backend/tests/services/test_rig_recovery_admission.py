"""A local rig recovery is admitted with the donor body hashed and parsed outside the process lock, and written only
if the records it was decided on are unchanged under it."""
import shutil

import pytest

from native_assembly_fixture import JOB, VERSION, seed_native_assembly
from src.services import avatar_rig_transfer
from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.avatar_rig_transfer import AvatarRigTransfer
from src.services.character_pipeline import PipelineError, read_json

TARGET = 'd' * 24
KEY = 'rig-recovery-0001'


@pytest.fixture
def recovery(tmp_path, monkeypatch):
    """A job whose Meshy rig was refused (422), and a finished body (the fixture's) whose skeleton it may take."""
    monkeypatch.setattr(avatar_rig_transfer, 'blender_executable', lambda: 'blender')
    factory, donor = seed_native_assembly(tmp_path, 'fixture')
    target = factory.directory(1, TARGET)
    (target / 'output').mkdir(parents=True)
    (target / 'meshy').mkdir()
    shutil.copyfile(donor / 'body.glb', target / 'output/generated-body.glb')
    sha = digest(target / 'output/generated-body.glb')
    _write_json(target / 'job.json', {
        'id': TARGET, 'character_id': 'fixture', 'character_name': '복구', 'created_at': '2026-09-19T00:00:00+00:00',
        'status': 'review_required', 'input_kind': 'image', 'production_mode': 'character_parts', 'source_sha256': sha,
        'profile': {'name': 'fixture', 'rig': 'meshy-native'}, 'parts': [], 'files': {'generated-body.glb': sha}})
    _write_json(target / 'pipeline.json', {'parts': []})
    _write_json(target / 'meshy/character.json', {'stage': 'rigging', 'status': 'submission_rejected', 'http_status': 422})
    return AvatarRigTransfer(factory), target


def test_the_donor_is_hashed_and_parsed_without_the_process_lock(recovery, monkeypatch):
    service, target = recovery
    hashed, parsed = [], []
    real_digest, real_parse = avatar_rig_transfer.digest, avatar_rig_transfer.parse_glb
    monkeypatch.setattr(avatar_rig_transfer, 'digest', lambda path: (hashed.append(_LOCK._is_owned()), real_digest(path))[1])
    monkeypatch.setattr(avatar_rig_transfer, 'parse_glb',
                        lambda content, **kwargs: (parsed.append(_LOCK._is_owned()), real_parse(content, **kwargs))[1])
    state, request_id = service.start(1, TARGET, JOB, VERSION, KEY)
    assert request_id and state['status'] == 'accepted'
    assert hashed and not any(hashed) and parsed == [False]
    assert read_json(target / 'meshy/worker.json')['origin'] == 'rig_transfer'
    # The same key again is the same recovery.
    assert service.start(1, TARGET, JOB, VERSION, KEY)[1] == request_id
    with pytest.raises(PipelineError) as error:
        service.start(1, TARGET, JOB, '0' * 24, KEY)
    assert error.value.code == 'idempotency_conflict'


def test_a_job_that_changed_while_the_donor_was_read_is_read_again(recovery, monkeypatch):
    service, target = recovery
    parsed, real_parse = [], avatar_rig_transfer.parse_glb

    def parse(content, **kwargs):
        if not parsed:
            # Another writer records something about the job while the donor is read.
            _write_json(target / 'meshy/character.json',
                        {**read_json(target / 'meshy/character.json'), 'checked_at': '2026-10-06T00:00:00+00:00'})
        parsed.append(1)
        return real_parse(content, **kwargs)
    monkeypatch.setattr(avatar_rig_transfer, 'parse_glb', parse)
    state, request_id = service.start(1, TARGET, JOB, VERSION, KEY)
    assert request_id and state['status'] == 'accepted' and len(parsed) == 2


def test_a_recovery_admitted_meanwhile_is_not_admitted_again(recovery, monkeypatch):
    service, target = recovery
    real_parse = avatar_rig_transfer.parse_glb

    def parse(content, **kwargs):
        # The rig arrives meanwhile: the job no longer needs a recovery, and none is written.
        _write_json(target / 'meshy/delivery.json', {'version': 'a' * 24, 'files': {'model.glb': 'b' * 64}})
        return real_parse(content, **kwargs)
    monkeypatch.setattr(avatar_rig_transfer, 'parse_glb', parse)
    with pytest.raises(PipelineError) as error:
        service.start(1, TARGET, JOB, VERSION, KEY)
    assert error.value.code == 'transfer_unavailable'
    assert not (target / 'meshy/rig-transfer/current.json').exists()


def test_a_recovery_paused_before_its_blender_code_changed_runs_again_under_its_fixed_key(recovery):
    service, target = recovery
    key = 'base-body-rig-' + TARGET  # The key a base body's own recovery is always started under.
    _, request_id = service.start(1, TARGET, JOB, VERSION, key)
    directory = target / 'meshy/rig-transfer' / request_id
    accepted = read_json(directory / 'input.json')
    # Paused before a deployment that changed the Blender binding code.
    _write_json(directory / 'input.json', {**accepted, 'binding_sha256': '0' * 64})
    record = {**read_json(directory / 'record.json'), 'status': 'paused', 'error': '중단'}
    _write_json(directory / 'record.json', record)
    _write_json(target / 'meshy/worker.json', {**record, 'origin': 'rig_transfer'})
    state, again = service.start(1, TARGET, JOB, VERSION, key)
    assert again == request_id and state['status'] == 'accepted'
    # It runs with this release's worker code, on the body and donor it was accepted with.
    assert read_json(directory / 'input.json') == {**accepted, **avatar_rig_transfer._workers()}
