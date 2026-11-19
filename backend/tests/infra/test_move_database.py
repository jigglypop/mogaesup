"""server/scripts/move-database.py's instance script against stand-in aws, psql, pg_dump, pg_restore and systemctl: a move
that cannot list or compare the tables it moved is a failure that starts the service again, never "moved"."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / 'server' / 'scripts' / 'move-database.py'

STUBS = r'''
python3() { "$PYTHON_EXE" "$@"; }
aws() { echo '{"username": "admin", "password": "secret"}'; }
systemctl() { echo "systemctl $*" >> "$CALLS"; }
pg_dump() { :; }
pg_restore() { :; }
psql() {
  local query="$*"
  [ -t 0 ] || cat > /dev/null
  case "$query" in
    *"SELECT tablename"*) [ -z "${FAIL_TABLES:-}" ] || return 2; echo accounts; echo islands ;;
    *"FROM pg_tables"*) echo 0 ;;
    *"FROM pg_extension"*) ;;
    *"count(*) FROM public."*) echo 7 ;;
  esac
}
'''


def instance_script(tmp_path):
    spec = importlib.util.spec_from_file_location('move_database', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (tmp_path / 'app-password').write_text('app-password\n')
    text = (module.SCRIPT.replace('{region}', 'ap-northeast-2').replace('{from_secret}', 'from').replace('{to_secret}', 'to')
            .replace('{from_endpoint}', 'old.invalid').replace('{to_endpoint}', 'new.invalid')
            .replace('/etc/mogaesup/app-password', (tmp_path / 'app-password').as_posix())
            .replace('/var/tmp/mogaesup.dump', (tmp_path / 'mogaesup.dump').as_posix())
            .replace('/opt/mogaesup/global-bundle.pem', (tmp_path / 'bundle.pem').as_posix()))
    first, rest = text.strip().split('\n', 1)
    assert first == 'set -euo pipefail'
    path = tmp_path / 'move.sh'
    path.write_text(f'{first}\n{STUBS}\n{rest}\n', newline='\n')
    return path


def run(bash, tmp_path, **env):
    calls = tmp_path / 'calls.txt'
    calls.write_text('')
    # The stand-ins are shell functions, which the script finds before any aws or psql on PATH.
    done = subprocess.run([bash, instance_script(tmp_path).as_posix()], capture_output=True, text=True, timeout=60,
                          stdin=subprocess.DEVNULL,
                          env={**os.environ, 'PYTHON_EXE': sys.executable, 'CALLS': calls.as_posix(), **env})
    return done, calls.read_text().split('\n')


def test_a_move_whose_tables_compare_says_moved_and_leaves_the_service_stopped(bash, tmp_path):
    done, calls = run(bash, tmp_path)
    assert done.returncode == 0, done.stdout + done.stderr
    assert 'accounts 7 7' in done.stdout and 'moved;' in done.stdout
    assert 'systemctl stop mogaesup.service' in calls and 'systemctl start mogaesup.service' not in calls


@pytest.mark.parametrize('failure', ['FAIL_TABLES'])
def test_a_table_list_that_cannot_be_read_fails_the_move_and_starts_the_service_again(bash, tmp_path, failure):
    done, calls = run(bash, tmp_path, **{failure: '1'})
    assert done.returncode != 0 and 'moved;' not in done.stdout
    assert 'starting the service on the old database' in done.stdout
    assert 'systemctl start mogaesup.service' in calls
