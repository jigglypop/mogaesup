"""server/scripts/set-factory-jwt.py: the order of its steps and the scripts it runs on the instances."""
import importlib.util
from pathlib import Path
import subprocess
import sys

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / 'server' / 'scripts' / 'set-factory-jwt.py'
KEY = 'k' * 64


@pytest.fixture(scope='module')
def jwt():
    spec = importlib.util.spec_from_file_location('set_factory_jwt', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize('name', ['STUDIO_STATE', 'SERVER_STATE', 'SERVER_SET'])
def test_the_instance_scripts_are_valid_bash(jwt, bash, name):
    text = getattr(jwt, name).replace('{bucket}', 'bucket').replace('{key}', 'config/key').replace('{region}', 'ap-northeast-2')
    done = subprocess.run([bash, '-n'], input=text.encode(), capture_output=True, timeout=60)
    assert done.returncode == 0, done.stderr.decode(errors='replace')


def test_the_studio_verifies_the_key_before_the_server_signs_with_it(jwt):
    want = jwt.fingerprint(KEY)
    steps = jwt.plan(True, want, {'jwt': 'none', 'release': 'r'}, {'jwt': 'none', 'factory_url': 'set'})
    assert [name for name, _ in steps] == ['secret', 'studio', 'server']
    steps = jwt.plan(False, want, {'jwt': 'none', 'release': 'r'}, {'jwt': want, 'factory_url': 'set'})
    assert [name for name, _ in steps] == ['studio']
    assert jwt.plan(False, want, {'jwt': want}, {'jwt': want, 'factory_url': 'set'}) == []
    with pytest.raises(SystemExit, match='FACTORY_URL'):
        jwt.plan(False, want, {'jwt': want}, {'jwt': 'none', 'factory_url': 'none'})
    assert all(KEY not in text for _, text in jwt.plan(True, want, {}, {'factory_url': 'set'}))


def server_writer(jwt, tmp_path, env_text, value):
    text = jwt.SERVER_SET
    body = text[text.index("<<'PY'\n") + len("<<'PY'\n"):text.index('\nPY\n')]
    env = tmp_path / 'server.env'
    env.write_text(env_text)
    secret = tmp_path / 'value'
    secret.write_text(value + '\n')
    done = subprocess.run([sys.executable, '-', str(secret)], input=body.replace('/etc/mogaesup/server.env', env.as_posix()),
                          capture_output=True, text=True)
    return done, env.read_text()


def test_the_server_env_gets_the_key_once_and_keeps_the_rest(jwt, tmp_path):
    done, text = server_writer(jwt, tmp_path, 'DATABASE_URL=x\nFACTORY_URL=https://studio\nFACTORY_JWT_SECRET=old\n', KEY)
    assert done.returncode == 0, done.stderr
    assert text == f'DATABASE_URL=x\nFACTORY_URL=https://studio\nFACTORY_JWT_SECRET={KEY}\n'
    assert KEY not in done.stdout + done.stderr


@pytest.mark.parametrize('env_text, value, message', [
    ('DATABASE_URL=x\n', KEY, 'no FACTORY_URL'),
    ('FACTORY_URL=https://studio\n', 'short', 'not valid'),
    ('FACTORY_URL=https://studio\n', 'k' * 40 + '\nINJECTED=1', 'not valid'),
])
def test_the_server_env_is_left_alone_without_a_gateway_or_a_valid_key(jwt, tmp_path, env_text, value, message):
    done, text = server_writer(jwt, tmp_path, env_text, value)
    assert done.returncode != 0 and message in done.stderr and text == env_text
