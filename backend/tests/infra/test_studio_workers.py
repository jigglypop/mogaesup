"""The studio's Blender workers as their own user: the wrapper that starts them, the data root they share with the API,
and the host firewall rule that keeps them from the instance metadata service."""
import importlib.util
import inspect
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

INFRA = Path(__file__).resolve().parents[2] / 'infra'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope='module')
def wrapper():
    return load('blender_worker', INFRA / 'blender-worker.py')


@pytest.fixture(scope='module')
def entrypoint():
    return load('studio_entrypoint', INFRA / 'entrypoint.py')


def test_root_starts_blender_as_the_worker_in_the_same_process(wrapper):
    seen = []

    def execve(path, argv, env):
        seen.append((path, argv, env))
    dropped = []
    wrapper.main(['/usr/local/bin/blender', '--background', '--python', 'x.py'], {'HOME': '/root', 'KEEP': '1'},
                 execve=execve, getuid=lambda: 0, become=lambda: dropped.append(True))
    assert dropped == [True]
    assert seen == [(wrapper.BLENDER, [wrapper.BLENDER, '--background', '--python', 'x.py'],
                     {'HOME': wrapper.HOME, 'KEEP': '1'})]


def test_another_user_runs_blender_as_itself(wrapper):
    seen = []
    wrapper.main(['blender', '-v'], {'HOME': '/home/me'}, execve=lambda *call: seen.append(call), getuid=lambda: 1000,
                 become=lambda: pytest.fail('only root changes user'))
    assert seen == [(wrapper.BLENDER, [wrapper.BLENDER, '-v'], {'HOME': '/home/me'})]


def test_one_worker_uid_everywhere(wrapper, entrypoint):
    dockerfile = (INFRA / 'Dockerfile').read_text(encoding='utf-8')
    guard = (INFRA / 'worker-guard.sh').read_text(encoding='utf-8')
    assert wrapper.WORKER == entrypoint.WORKER == 10001
    assert f'groupadd --gid {wrapper.WORKER} studio-worker' in dockerfile
    assert f'useradd --uid {wrapper.WORKER} --gid {wrapper.WORKER}' in dockerfile
    assert f'--home-dir {wrapper.HOME}' in dockerfile
    assert f'worker_uid={wrapper.WORKER}' in guard
    # The real Blender lives where the wrapper starts it, and the wrapper is what BLENDER_EXECUTABLE names.
    assert 'ln -s /opt/blender-${BLENDER_VERSION}-linux-x64 /opt/blender' in dockerfile
    assert wrapper.BLENDER == '/opt/blender/blender'
    assert 'COPY infra/blender-worker.py /usr/local/bin/blender' in dockerfile
    assert re.search(r'BLENDER_EXECUTABLE=/usr/local/bin/blender\b', dockerfile)
    assert dockerfile.index('COPY infra/blender-worker.py') < dockerfile.index('RUN blender --background')


def fake_tree(entries):
    """lstat for a fake data root: path -> (mode, gid)."""
    def lstat(path):
        mode, gid = entries[os.fspath(path)]
        return SimpleNamespace(st_mode=mode, st_gid=gid)
    return lstat


def test_the_data_root_is_shared_with_the_workers_group(entrypoint, tmp_path):
    root = tmp_path / 'data'
    (root / 'runs/one').mkdir(parents=True)
    (root / 'runs/one/input.json').write_text('{}')
    (root / '.runtime').mkdir()
    (root / '.runtime/admission.guard').write_text('0')
    owned = {os.fspath(path): (stat.S_IFDIR | 0o755 if path.is_dir() else stat.S_IFREG | 0o644, 0)
             for path in [root, *root.rglob('*')]}
    chowned, modes = {}, {}
    changed = entrypoint.share_with_workers(root, lstat=fake_tree(owned),
                                            chown=lambda path, uid, gid: chowned.setdefault(os.fspath(path), (uid, gid)),
                                            chmod=lambda path, mode: modes.setdefault(os.fspath(path), mode))
    # Only the group changes, on everything.
    assert changed == len(owned)
    assert chowned == dict.fromkeys(owned, (-1, 10001))
    assert set(modes) == set(owned)
    assert modes[os.fspath(root)] == 0o2775 and modes[os.fspath(root / 'runs/one')] == 0o2775
    assert modes[os.fspath(root / 'runs/one/input.json')] == 0o664


def test_a_shared_data_root_is_only_read_again(entrypoint, tmp_path):
    root = tmp_path / 'data'
    (root / 'runs').mkdir(parents=True)
    (root / 'runs/out.glb').write_bytes(b'glTF')
    shared = {os.fspath(root): (stat.S_IFDIR | 0o2775, 10001), os.fspath(root / 'runs'): (stat.S_IFDIR | 0o2770, 10001),
              os.fspath(root / 'runs/out.glb'): (stat.S_IFREG | 0o664, 10001)}
    assert entrypoint.share_with_workers(root, lstat=fake_tree(shared),
                                         chown=lambda *call: pytest.fail(f'changed {call}'),
                                         chmod=lambda *call: pytest.fail(f'changed {call}')) == 0


def test_the_worker_check_shares_only_what_it_writes_in(entrypoint, tmp_path):
    # The deployment's 90 s worker check must not walk a data root of any size: the deploy shared it just before
    # (--share-data). Only the root and .runtime, where the check makes its folder, are seen to here.
    root = tmp_path / 'data'
    (root / 'runs/one').mkdir(parents=True)
    (root / 'runs/one/input.json').write_text('{}')
    (root / '.runtime').mkdir()
    owned = {os.fspath(path): (stat.S_IFDIR | 0o755 if path.is_dir() else stat.S_IFREG | 0o644, 0)
             for path in [root, *root.rglob('*')]}
    chowned = []
    entrypoint.share_runtime(root, lstat=fake_tree(owned), chown=lambda path, uid, gid: chowned.append(os.fspath(path)),
                             chmod=lambda path, mode: None)
    assert chowned == [os.fspath(root), os.fspath(root / '.runtime')]
    # A data root without .runtime yet: the check makes it, in the shared root.
    def missing(path):
        raise FileNotFoundError(path)
    fresh = tmp_path / 'fresh'
    entrypoint.share_runtime(fresh, lstat=missing, chown=lambda *call: pytest.fail(f'changed {call}'),
                             chmod=lambda *call: pytest.fail(f'changed {call}'))
    assert fresh.is_dir()
    assert inspect.signature(entrypoint.check_workers).parameters['share'].default is entrypoint.share_runtime


def test_the_share_mode_shares_the_whole_data_root_and_says_how_much_changed(entrypoint, tmp_path, capsys):
    seen = []
    assert entrypoint.share_data(tmp_path, share=lambda root: seen.append(root) or 12) == 0
    assert seen == [tmp_path] and f"{tmp_path} is shared with uid 10001's group (12 entries changed)" in capsys.readouterr().out
    source = (INFRA / 'entrypoint.py').read_text(encoding='utf-8')
    assert "if '--share-data' in sys.argv[1:]:" in source and 'sys.exit(share_data())' in source


def test_links_and_files_that_went_meanwhile_are_left_alone(entrypoint, tmp_path):
    root = tmp_path / 'data'
    root.mkdir()
    (root / 'gone.json').write_text('{}')
    (root / 'link').write_text('')
    entries = {os.fspath(root): (stat.S_IFDIR | 0o2775, 10001), os.fspath(root / 'link'): (stat.S_IFLNK | 0o777, 0)}

    def lstat(path):
        if os.fspath(path) not in entries:
            raise FileNotFoundError(path)
        return fake_tree(entries)(path)
    entrypoint.share_with_workers(root, lstat=lstat, chown=lambda *call: pytest.fail(f'changed {call}'),
                                  chmod=lambda *call: pytest.fail(f'changed {call}'))


@pytest.mark.skipif(os.name == 'nt', reason='a POSIX umask and file modes')
def test_the_worker_check_runs_blender_where_the_api_leaves_work(entrypoint, tmp_path, capsys):
    blender = tmp_path / 'blender'
    # A stand-in that runs the expression the check gives Blender.
    blender.write_text(f'#!{sys.executable}\nimport sys\nexec(sys.argv[sys.argv.index("--python-expr") + 1])\n')
    blender.chmod(0o755)
    root = tmp_path / 'data'
    assert entrypoint.check_workers(root, blender=str(blender), worker=os.getuid(), share=lambda path: path.mkdir()) == 0
    assert f'Blender runs as uid {os.getuid()}' in capsys.readouterr().out
    assert list((root / '.runtime').iterdir()) == []
    # Blender as another user than the worker fails the check.
    assert entrypoint.check_workers(root, blender=str(blender), worker=os.getuid() + 1, share=lambda path: None) == 1
    assert 'worker check failed' in capsys.readouterr().err


GUARD_FAKES = r'''
iptables() { echo "iptables $*" >> "$CALLS"; if [[ "$2" == -C ]]; then return "${FAKE_HAS_RULE:-1}"; fi; }
ip6tables() { echo "ip6tables $*" >> "$CALLS"; if [[ "$2" == -C ]]; then return 1; fi; }
'''


def run_guard(bash, tmp_path, **env):
    calls = tmp_path / 'calls'
    calls.touch()
    script = GUARD_FAKES + (INFRA / 'worker-guard.sh').read_text(encoding='utf-8')
    done = subprocess.run([bash], input=script.encode('utf-8'), capture_output=True, timeout=60,
                          env={**os.environ, 'CALLS': str(calls), **env})
    return done, calls.read_text().splitlines()


def test_the_guard_refuses_the_worker_uid_the_metadata_addresses_and_the_api_ports(bash, tmp_path):
    done, calls = run_guard(bash, tmp_path)
    assert done.returncode == 0, done.stderr
    added = [call for call in calls if ' -I OUTPUT 1 ' in call]
    assert added == [
        'iptables -w -I OUTPUT 1 -d 169.254.169.254/32 -m owner --uid-owner 10001 -j REJECT',
        'iptables -w -I OUTPUT 1 -d 127.0.0.0/8 -p tcp --dport 8000 -m owner --uid-owner 10001 -j REJECT',
        'iptables -w -I OUTPUT 1 -d 127.0.0.0/8 -p tcp --dport 8080 -m owner --uid-owner 10001 -j REJECT',
        'ip6tables -w -I OUTPUT 1 -d fd00:ec2::254/128 -m owner --uid-owner 10001 -j REJECT',
        'ip6tables -w -I OUTPUT 1 -d ::1/128 -p tcp --dport 8000 -m owner --uid-owner 10001 -j REJECT',
        'ip6tables -w -I OUTPUT 1 -d ::1/128 -p tcp --dport 8080 -m owner --uid-owner 10001 -j REJECT']


def test_the_guard_adds_its_rule_once(bash, tmp_path):
    done, calls = run_guard(bash, tmp_path, FAKE_HAS_RULE='0')
    assert done.returncode == 0
    assert not any(' -I ' in call for call in calls if call.startswith('iptables'))


def test_the_guard_is_valid_bash(bash):
    done = subprocess.run([bash, '-n'], input=(INFRA / 'worker-guard.sh').read_bytes(), capture_output=True, timeout=60)
    assert done.returncode == 0, done.stderr
