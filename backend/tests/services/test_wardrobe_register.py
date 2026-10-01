import hashlib

import pytest

from services.test_character_preparation import animated_fixture
from src.services import avatar_fitting_management, avatar_wardrobe
from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK
from src.services.avatar_fitting_management import FittingManagement, body_facts
from src.services.character_pipeline import PipelineError, read_json
from wardrobe_fixture import Library, sha

BODY, VERSION = 'b' * 24, '1' * 24
OTHER, OTHER_VERSION = 'c' * 24, '2' * 24


@pytest.fixture
def library(tmp_path, storage_configured):
    library = Library(tmp_path)
    for job, version in ((BODY, VERSION), (OTHER, OTHER_VERSION)):
        library.job(job)
        library.assembly(job, version, slots=())
        library.current(job, version)
    return library


def entry(job, version):
    return {'job_id': job, 'version': version, 'profile_id': f'body-{job[:8]}', 'geometry_sha256': sha(job),
            'body_sha256': sha(job + version)}


class Parsing:
    """A body_entry that records whether the process lock was held while the body was read and parsed."""

    def __init__(self, monkeypatch, *, during=None, source=None):
        self.held, self.calls = [], []
        source = source or {'character_name': '몸', 'base_body': {'body_type': 'male'}}

        def body_entry(management, job, version):
            self.calls.append((job, version))
            self.held.append(_LOCK._is_owned())
            if during:
                during()
            return entry(job, version), source
        monkeypatch.setattr(FittingManagement, 'body_entry', body_entry)


def test_a_body_is_parsed_before_the_process_lock_and_listed_under_it(library, monkeypatch):
    parsing = Parsing(monkeypatch)
    written = []
    real = avatar_wardrobe._write_json
    monkeypatch.setattr(avatar_wardrobe, '_write_json', lambda path, value: (written.append(_LOCK._is_owned()), real(path, value))[1])
    result = library.wardrobe.register(BODY, VERSION, '0')
    assert parsing.calls == [(BODY, VERSION)] and parsing.held == [False] and written == [True]
    assert [(body['job_id'], body['version'], body['name'], body['body_type']) for body in result['bodies']] == [(BODY, VERSION, '몸', 'male')]


def test_registering_a_listed_body_again_parses_nothing(library, monkeypatch):
    parsing = Parsing(monkeypatch)
    library.wardrobe.register(BODY, VERSION, '0')
    revision = library.wardrobe.bodies()['revision']
    again = library.wardrobe.register(BODY, VERSION, 'a stale revision')
    assert parsing.calls == [(BODY, VERSION)] and again['revision'] == revision


def test_a_stale_revision_is_refused_before_anything_is_parsed(library, monkeypatch):
    parsing = Parsing(monkeypatch)
    with pytest.raises(PipelineError) as error:
        library.wardrobe.register(BODY, VERSION, 'stale')
    assert error.value.code == 'revision_conflict' and parsing.calls == []


def test_a_list_changed_while_the_body_was_parsed_is_not_overwritten(library, monkeypatch):
    def meanwhile():
        _write_json(library.wardrobe.path, {'revision': 'rev-2', 'updated_at': 'then', 'bodies': [
            {**entry(OTHER, OTHER_VERSION), 'name': 'other', 'body_type': None, 'registered_at': 'then'}]})
    Parsing(monkeypatch, during=meanwhile)
    with pytest.raises(PipelineError) as error:
        library.wardrobe.register(BODY, VERSION, '0')
    assert error.value.code == 'revision_conflict'
    assert [body['job_id'] for body in read_json(library.wardrobe.path)['bodies']] == [OTHER]


def test_a_variant_job_is_not_registered(library, monkeypatch):
    Parsing(monkeypatch, source={'base_job_id': OTHER, 'character_name': '변형'})
    with pytest.raises(PipelineError) as error:
        library.wardrobe.register(BODY, VERSION, '0')
    assert error.value.code == 'variant_body' and library.wardrobe._stored()['bodies'] == []


def test_the_common_body_is_parsed_before_the_process_lock_too(library, monkeypatch):
    parsing = Parsing(monkeypatch)
    management = FittingManagement(library.factory, 1)
    saved = management.save_body_default(BODY, VERSION, '0')
    assert parsing.held == [False] and saved['body']['job_id'] == BODY and read_json(management.library.root/'body-profile.json') == saved
    # The same default again answers as it is; another call with a stale revision is refused.
    assert management.save_body_default(BODY, VERSION, 'stale') == saved
    with pytest.raises(PipelineError) as error:
        management.save_body_default(OTHER, OTHER_VERSION, 'stale')
    assert error.value.code == 'revision_conflict' and len(parsing.calls) == 1


def test_a_body_file_is_parsed_once_per_hash(tmp_path, monkeypatch):
    content = animated_fixture()
    path = tmp_path/'body.glb'
    path.write_bytes(content)
    monkeypatch.setattr(avatar_fitting_management, '_facts', type(avatar_fitting_management._facts)())
    calls, real = [], avatar_fitting_management.geometry_identity
    monkeypatch.setattr(avatar_fitting_management, 'geometry_identity', lambda data: (calls.append(1), real(data))[1])
    digest = hashlib.sha256(content).hexdigest()
    first = body_facts(path, digest)
    assert body_facts(path, digest) is first and calls == [1]
    assert first['identity'] == real(content) and first['clips'] == ['provider_clip']
