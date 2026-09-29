import pytest


@pytest.fixture(autouse=True)
def isolate_character_postgres(monkeypatch):
    # Character tests must not index disposable fixtures into the developer's DB.
    monkeypatch.setenv("CHARACTER_DATABASE_URL", "")
    monkeypatch.setenv("BLENDER_PORT", "62126")
