import pytest

from native_assembly_fixture import JOB, VERSION, seed_native_assembly
from src.api.avatar_factory import SinglePartVariantInput
from src.services import avatar_native_outfits
from src.services.avatar_native_outfits import AvatarNativeOutfits
from src.services.avatar_native_parts import AvatarNativeParts
from src.services.avatar_worn_images import BRIEF_MAX, build_prompt
from src.services.character_pipeline import PipelineError, read_json


def test_saved_combinations_keep_only_the_newest_receipts(tmp_path, monkeypatch):
    assert avatar_native_outfits.RECEIPTS_KEPT == 64
    kept = 5
    monkeypatch.setattr(avatar_native_outfits, 'RECEIPTS_KEPT', kept)
    factory, directory = seed_native_assembly(tmp_path, 'fixture')
    outfits = AvatarNativeOutfits(AvatarNativeParts(factory))
    current = outfits.get(1, JOB, VERSION)
    body, revision, saved = current['body_sha256'], current['revision'], []
    for number in range(kept + 3):
        payload = {'body_sha256': body, 'slots': ['top', 'shoes'] if number % 2 else ['top']}
        saved.append((payload, f'native-save-{number:04}', outfits.put(1, JOB, VERSION, payload, revision, f'native-save-{number:04}')))
        revision = saved[-1][2]['revision']
    state = read_json(directory/'selection.json')
    assert len(state['receipts']) == kept and state['current'] == saved[-1][2]
    # A lost response is still answered for the newest saves, and the selection is what the last save made.
    payload, key, result = saved[-1]
    assert outfits.put(1, JOB, VERSION, payload, 'a revision from before', key) == result
    assert outfits.get(1, JOB, VERSION) == result
    # The oldest receipt is gone: its key is a new request and meets the revision check.
    payload, key, _ = saved[0]
    with pytest.raises(PipelineError) as error:
        outfits.put(1, JOB, VERSION, payload, '0', key)
    assert error.value.code == 'revision_conflict'


def test_the_whole_design_brief_the_api_accepts_reaches_the_image_prompt():
    schema = SinglePartVariantInput.model_json_schema()['properties']['description']
    assert BRIEF_MAX == next(option['maxLength'] for option in schema['anyOf'] if 'maxLength' in option)
    brief = ''.join(chr(0xAC00 + index % 500) for index in range(BRIEF_MAX))
    prompt = build_prompt('top', 'front', key_name='magenta', notes=f'  {brief}  ')
    assert prompt.endswith('Design brief: ' + brief)
    # Only what the API would not have accepted is cut.
    assert build_prompt('top', 'front', key_name='magenta', notes=brief + 'extra').endswith('Design brief: ' + brief)
