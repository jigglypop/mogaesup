"""Motion defaults are read without the factory's process lock, and the legacy per-job files they may be resolved from
are listed before a write takes it."""
from src.services import avatar_meshy as module
from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, AvatarFactory

JOBS = ('a' * 24, 'b' * 24)


def service(tmp_path, monkeypatch, listed):
    factory = AvatarFactory(tmp_path)
    for index, job in enumerate(JOBS):
        (factory.root/'1'/job).mkdir(parents=True)
        _write_json(factory.root/'1'/job/'motion-defaults.json',
                    {'selections': {'walk': 14 + index}, 'updated_at': f'2026-09-0{index + 1}T00:00:00+00:00'})
    real = type(factory.root).glob

    def glob(self, pattern):
        listed.append(_LOCK._is_owned())
        return real(self, pattern)
    monkeypatch.setattr(type(factory.root), 'glob', glob)
    meshy = module.AvatarMeshy(factory)
    monkeypatch.setattr(meshy, 'validate_actions', lambda owner, selections: None)
    return meshy


def test_reading_the_defaults_takes_no_lock_and_lists_the_legacy_files_once(tmp_path, monkeypatch):
    listed = []
    meshy = service(tmp_path, monkeypatch, listed)
    locks = []
    monkeypatch.setattr(meshy, '_saved_defaults', lambda owner, real=meshy._saved_defaults: (locks.append(_LOCK._is_owned()), real(owner))[1])
    assert meshy.defaults(1)['selections'] == {'walk': 15}
    assert meshy.default_actions(1)['walk'] == 15
    assert locks == [False, False] and listed == [False]


def test_a_write_lists_the_legacy_files_before_the_lock_and_rereads_under_it(tmp_path, monkeypatch):
    listed = []
    meshy = service(tmp_path, monkeypatch, listed)
    saved = meshy.defaults(1, {'run': 77})
    assert saved['selections'] == {'walk': 15, 'run': 77} and saved['scope'] == 'owner'
    assert listed == [False]
    # The owner's own file now answers by itself.
    assert meshy.defaults(1)['selections'] == {'walk': 15, 'run': 77} and listed == [False]
