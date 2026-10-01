import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / 'infra' / 'deploy-on-instance.sh'
UNREADABLE = 'running release health cannot be read'
BUSY = '{"status":"healthy","activity":{"paid_requests":1,"running_tasks":0}}'
IDLE = '{"status":"healthy","activity":{"paid_requests":0,"running_tasks":0}}'


def run_bash(bash, script, *flags, **env):
    # Bytes in, so that Windows does not turn the script's line ends into CRLF for bash.
    done = subprocess.run([bash, *flags], input=script.encode('utf-8'), capture_output=True, timeout=60,
                          env={**os.environ, 'PYTHON_EXE': sys.executable, **env})
    return SimpleNamespace(code=done.returncode, out=done.stdout.decode('utf-8', 'replace'),
                           err=done.stderr.decode('utf-8', 'replace'))


def drain_loop():
    text = SCRIPT.read_text(encoding='utf-8')
    start = text.index('drain_deadline=')
    return text[start:text.index('\ndone\n', start) + len('\ndone\n')]


def run_drain(bash, reply, **env):
    """Runs the script's drain loop with the running container and its /api/health faked: `reply` is what curl answers."""
    script = '\n'.join([
        'set -Eeuo pipefail', 'service_name=gaesup-asset-studio',
        'docker() { echo true; }',
        'curl() { if [ "$FAKE_REPLY" = refused ]; then return 7; fi; printf "%s" "$FAKE_REPLY"; }',
        'python3() { "$PYTHON_EXE" "$@"; }',
        drain_loop(), 'echo past-the-loop'])
    return run_bash(bash, script, FAKE_REPLY=reply, ASSET_DEPLOY_DRAIN_SECONDS='0', **env)


def test_the_script_is_valid_bash(bash):
    done = run_bash(bash, SCRIPT.read_text(encoding='utf-8'), '-n')
    assert done.code == 0, done.err


@pytest.mark.parametrize('reply', ['refused', '<html>502 Bad Gateway</html>'])
def test_an_unreadable_health_stops_the_deploy(bash, reply):
    done = run_drain(bash, reply)
    assert done.code == 5 and UNREADABLE in done.err and 'ALLOW_UNKNOWN_DRAIN=1' in done.err
    assert 'past-the-loop' not in done.out


def test_allow_unknown_drain_replaces_it_anyway(bash):
    done = run_drain(bash, 'refused', ALLOW_UNKNOWN_DRAIN='1')
    assert done.code == 0 and 'past-the-loop' in done.out
    assert UNREADABLE in done.err and 'replacing it anyway' in done.err


def test_only_one_allows_it(bash):
    assert run_drain(bash, 'refused', ALLOW_UNKNOWN_DRAIN='true').code == 5


def test_an_idle_release_is_replaced_without_a_word(bash):
    done = run_drain(bash, IDLE)
    assert done.code == 0 and 'past-the-loop' in done.out and done.err == ''


def test_a_busy_release_still_stops_the_deploy_after_the_drain_time(bash):
    done = run_drain(bash, BUSY, ALLOW_UNKNOWN_DRAIN='1')
    assert done.code == 4 and 'still has 1 paid or background tasks' in done.err


def test_the_studio_container_logs_are_rotated():
    text = SCRIPT.read_text(encoding='utf-8')
    start = text.index('docker run -d')
    run = text[start:text.index('\n  "$image" >/dev/null', start)]
    assert '--log-opt max-size=50m' in run and '--log-opt max-file=3' in run
