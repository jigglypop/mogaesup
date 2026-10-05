"""The total face cap of a separate_parts input is checked on the raw lists, before any face is converted."""
import pytest
from pydantic import ValidationError

from src.api import characters as api

SHA = 'a' * 64


def selection(faces):
    return {'node_index': 0, 'role': 'top', 'primitive_index': 0, 'faces': faces}


def test_a_total_over_the_cap_is_refused_before_any_face_is_converted(monkeypatch):
    monkeypatch.setattr(api, 'MAX_SELECTED_FACES', 79)
    # Faces that cannot be converted: an int error would mean the lists were converted before the total was seen.
    with pytest.raises(ValidationError) as refused:
        api.SegmentationInput.model_validate({'source_sha256': SHA,
                                              'selections': [selection(['unconverted'] * 40)] * 2})
    errors = refused.value.errors()
    assert [error['type'] for error in errors] == ['value_error']
    assert 'too many selected faces' in errors[0]['msg']


def test_a_total_at_the_cap_is_converted_and_kept(monkeypatch):
    monkeypatch.setattr(api, 'MAX_SELECTED_FACES', 80)
    value = api.SegmentationInput.model_validate({'source_sha256': SHA, 'selections': [selection(list(range(40)))] * 2})
    assert [len(item.faces) for item in value.selections] == [40, 40]


def test_lists_each_within_their_own_cap_are_refused_at_the_real_total_before_conversion():
    half = api.MAX_SELECTED_FACES // 2 + 1
    with pytest.raises(ValidationError) as refused:
        api.SegmentationInput.model_validate({'source_sha256': SHA, 'selections': [selection(['unconverted'] * half)] * 2})
    assert [error['type'] for error in refused.value.errors()] == ['value_error']


@pytest.mark.parametrize('body', [
    [], {'source_sha256': SHA, 'selections': 'none'}, {'source_sha256': SHA, 'selections': ['none']},
    {'source_sha256': SHA, 'selections': [selection('none')]},
    {'source_sha256': SHA, 'selections': [selection([0])] * (api.MAX_SELECTIONS + 1)},
])
def test_malformed_inputs_reach_the_ordinary_field_errors(body):
    with pytest.raises(ValidationError) as refused:
        api.SegmentationInput.model_validate(body)
    assert 'too many selected faces' not in str(refused.value)
