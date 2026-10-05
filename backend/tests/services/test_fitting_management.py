import hashlib

import pytest

from lock_probe import lock_free
from src.services import avatar_native_parts
from src.services.asset_editor import _write_json
from src.services.avatar_factory import digest
from src.services.avatar_fitting_management import FittingManagement, saved_build
from src.services.character_pipeline import PipelineError, read_json
from wardrobe_fixture import OWNER, Library, put

JOB, V1, V2 = 'c' * 24, 'a' * 24, 'e' * 24
RAW = b'raw top model'
RAW_SHA = hashlib.sha256(RAW).hexdigest()
OLD_SHA = 'f' * 64


@pytest.fixture
def library(tmp_path, storage_configured):
    library = Library(tmp_path)
    library.job(JOB, requested=['top', 'bottom'], files={'generated-top.glb': RAW_SHA})
    directory = library.directory(JOB)
    (directory/'output').mkdir(parents=True, exist_ok=True)
    (directory/'output'/'generated-top.glb').write_bytes(RAW)
    # Object storage has no directories to make; a local disk needs the one select writes its receipt in.
    (directory/'native-parts'/'selections').mkdir(parents=True, exist_ok=True)
    put(directory/'pipeline.json', {'parts': [{'slot': 'top', 'description': '티셔츠'}, {'slot': 'bottom', 'description': '청바지'}]})
    return library


def seal(library, version, inputs, *, reports=None):
    """A sealed assembly with real model files (select checks each one) and the input it was built from."""
    library.assembly(JOB, version, slots=('top', 'bottom'), contents={slot: f'{version}:{slot}'.encode() for slot in ('body', 'model', 'top', 'bottom')})
    put(library.directory(JOB)/'native-parts'/version/'input.json', inputs)
    if reports:
        path = library.directory(JOB)/'native-parts'/version/'record.json'
        record = read_json(path)
        record['result']['parts'] = [{**part, **reports.get(part['slot'], {})} for part in record['result']['parts']]
        _write_json(path, record)


def profile_of(library, version, fit_profile):
    seal(library, version, {'parts': [{'slot': 'top', 'part_method': 'isolated', 'fit_profile': fit_profile}], 'prefit_parts': []})
    return FittingManagement(library.factory, OWNER).part_profile(JOB, 'top', version)


def test_a_saved_profile_keeps_the_hash_of_the_mesh_its_anchors_were_measured_on(library):
    profile = {'anchors': [{'name': 'cuff', 'source': [0, 1, 0]}], 'source_sha256': OLD_SHA}
    value = profile_of(library, V1, profile)
    # The file as it is now is reported beside it, so that a refit can tell the anchors belong to an older mesh.
    assert value['fit_profile']['source_sha256'] == OLD_SHA and value['source_sha256'] == RAW_SHA
    assert value['fit_profile']['anchors'] == profile['anchors']


def test_a_profile_measured_on_the_current_mesh_matches_it(library):
    value = profile_of(library, V1, {'source_sha256': RAW_SHA})
    assert value['fit_profile']['source_sha256'] == value['source_sha256'] == RAW_SHA


def test_a_profile_that_never_recorded_a_mesh_is_taken_to_belong_to_the_current_one(library):
    assert profile_of(library, V1, None)['fit_profile']['source_sha256'] == RAW_SHA
    assert profile_of(library, V2, {'sleeve': 'short'})['fit_profile']['source_sha256'] == RAW_SHA


@pytest.mark.parametrize('entry, expected', [
    ({'slot': 'top', 'part_method': 'isolated'}, ('isolated', None)),
    ({'slot': 'top', 'part_method': 'worn', 'shape': {'hem': .5}}, ('worn', None)),
    ({'slot': 'top', 'part_method': 'body_shell', 'shape': {'sleeve': .4, 'fit': 'loose'}}, ('body_shell', {'sleeve': .4, 'fit': 'loose'})),
    ({'slot': 'top', 'part_method': 'body_shell', 'shape': {}}, ('body_shell', None)),
    ({'slot': 'top', 'part_method': 'body_shell'}, ('body_shell', None)),
    # A slot carried over from an earlier assembly: the fit report it was sealed with says how it was built.
    ({'slot': 'top', 'report': {'fit_method': 'body-shell-v1', 'shape': {'sleeve': 0.0, 'hem': .6, 'hem_z_m': .9, 'fit': 'normal'}}},
     ('body_shell', {'sleeve': 0.0, 'hem': .6})),
    ({'slot': 'top', 'report': {'fit_method': 'body-shell-v1', 'shape': {'fit': 'tight'}}}, ('body_shell', {'fit': 'tight'})),
    ({'slot': 'top', 'report': {'fit_method': 'body-shell-v1', 'shape': {'fit': 'normal'}}}, ('body_shell', None)),
    ({'slot': 'top', 'report': {'fit_method': 'worn-extract-v1'}}, ('worn', None)),
    ({'slot': 'top', 'report': {'fit_method': 'limb-fit-v2', 'shape': {'hem': .6}}}, ('isolated', None)),
    # Nothing in the input proves it.
    ({'slot': 'top'}, (None, None)),
    ({'slot': 'top', 'report': {}}, (None, None)),
    ({'slot': 'top', 'part_method': 'unknown', 'report': {}}, (None, None)),
])
def test_how_a_slot_was_built_is_read_only_where_the_sealed_input_shows_it(entry, expected):
    assert saved_build(entry) == expected


def pipeline_parts(library):
    return {part['slot']: part for part in read_json(library.directory(JOB)/'pipeline.json')['parts']}


def test_choosing_an_older_version_gives_back_its_part_method_and_shape(library):
    # v1 built the top from the saved model and carried the bottom over from a body-shell build; v2, the current one,
    # rebuilt the top as a body shell and the bottom from its model.
    seal(library, V1, {'parts': [{'slot': 'top', 'part_method': 'isolated', 'garment_kind': 'source', 'fit_profile': {'kind': 'source'}}],
                       'prefit_parts': [{'slot': 'bottom', 'garment_kind': 'source', 'fit_profile': None,
                                         'report': {'fit_method': 'body-shell-v1', 'shape': {'hem': .5, 'fit': 'loose', 'hem_z_m': .4}}}]})
    seal(library, V2, {'parts': [{'slot': 'top', 'part_method': 'body_shell', 'shape': {'sleeve': 1}, 'garment_kind': 'source', 'fit_profile': None}],
                       'prefit_parts': [{'slot': 'bottom', 'garment_kind': 'source', 'fit_profile': None,
                                         'report': {'fit_method': 'limb-fit-v2'}}]})
    library.current(JOB, V2)
    pipeline = read_json(library.directory(JOB)/'pipeline.json')
    pipeline['parts'][0].update(part_method='body_shell', shape={'sleeve': 1})
    pipeline['parts'][1].update(part_method='isolated')
    _write_json(library.directory(JOB)/'pipeline.json', pipeline)

    FittingManagement(library.factory, OWNER).select(JOB, V1, V2, 'select-v1')
    parts = pipeline_parts(library)
    assert parts['top']['part_method'] == 'isolated' and 'shape' not in parts['top']
    assert parts['bottom']['part_method'] == 'body_shell' and parts['bottom']['shape'] == {'hem': .5, 'fit': 'loose'}
    assert parts['top']['fit_profile'] == {'kind': 'source'}
    assert read_json(library.directory(JOB)/'native-parts/current.json') == {'version': V1}

    # And back: v2 names the top's shell and its shape; its bottom was carried over from a model fit.
    FittingManagement(library.factory, OWNER).select(JOB, V2, V1, 'select-v2')
    parts = pipeline_parts(library)
    assert parts['top']['part_method'] == 'body_shell' and parts['top']['shape'] == {'sleeve': 1}
    assert parts['bottom']['part_method'] == 'isolated' and 'shape' not in parts['bottom']


def test_a_slot_whose_input_does_not_show_its_method_keeps_the_one_it_has(library):
    seal(library, V1, {'parts': [{'slot': 'top', 'garment_kind': 'source'}],
                       'prefit_parts': [{'slot': 'bottom', 'garment_kind': 'source', 'report': {}}]})
    seal(library, V2, {'parts': [], 'prefit_parts': []})
    library.current(JOB, V2)
    pipeline = read_json(library.directory(JOB)/'pipeline.json')
    pipeline['parts'][0].update(part_method='body_shell', shape={'hem': .3})
    pipeline['parts'][1].update(part_method='body_shell')
    _write_json(library.directory(JOB)/'pipeline.json', pipeline)
    FittingManagement(library.factory, OWNER).select(JOB, V1, V2, 'select-v1')
    parts = pipeline_parts(library)
    assert (parts['top']['part_method'], parts['top']['shape'], parts['bottom']['part_method']) == ('body_shell', {'hem': .3}, 'body_shell')


def two_versions(library):
    seal(library, V1, {'parts': [{'slot': 'top', 'part_method': 'isolated'}], 'prefit_parts': []})
    seal(library, V2, {'parts': [{'slot': 'top', 'part_method': 'body_shell'}], 'prefit_parts': []})
    library.current(JOB, V2)


def test_a_selection_hashes_the_models_while_the_process_lock_is_free(library, monkeypatch):
    two_versions(library)
    hashed = []
    monkeypatch.setattr(avatar_native_parts, 'digest', lambda path: (hashed.append(lock_free()), digest(path))[1])
    state = FittingManagement(library.factory, OWNER).select(JOB, V1, V2, 'select-v1')
    assert state['version'] == V1 and read_json(library.directory(JOB)/'native-parts/current.json') == {'version': V1}
    # body, model, top and bottom of the selected version, each hashed with the lock free.
    assert len(hashed) == 4 and all(hashed)


def test_a_version_moved_while_the_models_are_hashed_is_not_selected(library, monkeypatch):
    two_versions(library)
    pipeline = read_json(library.directory(JOB)/'pipeline.json')

    def assembled_meanwhile(path):
        library.current(JOB, 'd' * 24)
        return digest(path)
    monkeypatch.setattr(avatar_native_parts, 'digest', assembled_meanwhile)
    with pytest.raises(PipelineError) as error:
        FittingManagement(library.factory, OWNER).select(JOB, V1, V2, 'select-v1')
    assert error.value.code == 'revision_conflict'
    assert read_json(library.directory(JOB)/'pipeline.json') == pipeline
    assert read_json(library.directory(JOB)/'native-parts/current.json') == {'version': 'd' * 24}
    assert not list((library.directory(JOB)/'native-parts/selections').iterdir())


def test_a_selection_that_was_made_is_answered_again_without_hashing(library, monkeypatch):
    two_versions(library)
    service = FittingManagement(library.factory, OWNER)
    service.select(JOB, V1, V2, 'select-v1')
    monkeypatch.setattr(avatar_native_parts, 'digest', lambda path: pytest.fail('a replay must not hash the models'))
    assert service.select(JOB, V1, V2, 'select-v1')['version'] == V1
    with pytest.raises(PipelineError) as error:
        service.select(JOB, V2, V1, 'select-v1')
    assert error.value.code == 'idempotency_conflict'
