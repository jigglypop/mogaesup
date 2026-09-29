import json
from pathlib import Path

import pytest

from src.services.asset_editor import _write_json
from src.services.character_pipeline import read_json


def test_journal_retries_windows_rename_without_rewriting_payload(tmp_path, monkeypatch):
    target = tmp_path / "operation.json"
    target.write_text('{"status":"accepted"}', encoding="utf-8")
    original_replace = Path.replace
    attempts = []
    delays = []

    def replace(source, destination):
        attempts.append(source)
        if len(attempts) < 3:
            assert json.loads(target.read_text()) == {"status": "accepted"}
            error = PermissionError("temporarily open")
            error.winerror = 5
            raise error
        return original_replace(source, destination)

    monkeypatch.setattr(Path, "replace", replace)
    monkeypatch.setattr("src.services.asset_editor.time.sleep", delays.append)
    _write_json(target, {"status": "succeeded"})

    assert json.loads(target.read_text()) == {"status": "succeeded"}
    assert len(attempts) == 3 and len(set(attempts)) == 1
    assert delays == [.01, .02]
    assert list(tmp_path.glob("*.tmp")) == []


def test_journal_reader_retries_open_and_keeps_actual_status(tmp_path, monkeypatch):
    target = tmp_path / "operation.json"
    target.write_text('{"status":"succeeded"}', encoding="utf-8")
    original_read = Path.read_text
    attempts = []

    def read(path, *args, **kwargs):
        attempts.append(path)
        if len(attempts) < 3:
            error = PermissionError(13, "temporarily unavailable")
            error.winerror = 5
            raise error
        return original_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read)
    monkeypatch.setattr("src.services.asset_editor.time.sleep", lambda _: None)
    assert read_json(target, {"status": "unknown"}) == {"status": "succeeded"}
    assert len(attempts) == 3


def test_journal_reader_only_defaults_missing_files(tmp_path):
    target = tmp_path / "operation.json"
    assert read_json(target, {"status": "unknown"}) == {"status": "unknown"}
    target.write_text("invalid JSON", encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        read_json(target)


@pytest.mark.parametrize("winerror,attempt_count", [(5, 6), (32, 6), (33, 6), (None, 1)])
def test_journal_failed_commit_preserves_previous_state(tmp_path, monkeypatch, winerror, attempt_count):
    target = tmp_path / "operation.json"
    target.write_text('{"status":"accepted"}', encoding="utf-8")
    attempts = []
    failure = PermissionError("unavailable")
    if winerror is not None:
        failure.winerror = winerror

    def replace(source, destination):
        attempts.append(source)
        raise failure

    monkeypatch.setattr(Path, "replace", replace)
    monkeypatch.setattr("src.services.asset_editor.time.sleep", lambda _: None)
    with pytest.raises(PermissionError) as caught:
        _write_json(target, {"status": "succeeded"})

    assert caught.value is failure
    assert len(attempts) == attempt_count
    assert json.loads(target.read_text()) == {"status": "accepted"}
    assert list(tmp_path.glob("*.tmp")) == []
