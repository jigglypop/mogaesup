import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / 'infra' / 'deploy-on-instance.sh'
UNREADABLE = 'running release health cannot be read'
ADMISSION = {'version': 1, 'verified': True, 'draining': True}
BUSY = json.dumps({'status': 'healthy', 'activity': {'paid_requests': 1, 'running_tasks': 0}, 'admission': ADMISSION})
IDLE = json.dumps({'status': 'healthy', 'activity': {'paid_requests': 0, 'running_tasks': 0}, 'admission': ADMISSION})
READY = {"status": "healthy", "activity": {"paid_requests": 0, "running_tasks": 0},
         'admission': ADMISSION,
         "connections": {"database": {"configured": True, "ok": True}}}


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


def health_reader():
    text = SCRIPT.read_text(encoding='utf-8')
    start = text.index('health_snapshot() {')
    return text[start:text.index('\n}\n', start) + len('\n}\n')]


def run_drain(bash, reply, **env):
    """Runs the script's drain loop with the running container and its /api/health faked: `reply` is what curl answers."""
    script = '\n'.join([
        'set -Eeuo pipefail', 'service_name=gaesup-asset-studio',
        'docker() { echo true; }',
        'curl() { if [ "$FAKE_REPLY" = refused ]; then return 7; fi; printf "%s" "$FAKE_REPLY"; }',
        'python3() { "$PYTHON_EXE" "$@"; }',
        health_reader(), drain_loop(), 'echo past-the-loop'])
    return run_bash(bash, script, FAKE_REPLY=reply, ASSET_DEPLOY_DRAIN_SECONDS='0', **env)


def run_candidate(bash, tmp_path, replies):
    """Exercise the real candidate wait and rollback decision with successive health replies."""
    reply_file = tmp_path / 'replies.json'
    calls = tmp_path / 'health-calls'
    reply_file.write_text(json.dumps(replies), encoding='utf-8')
    text = SCRIPT.read_text(encoding='utf-8')
    start = text.index('healthy=false')
    probe = text[start:text.index('\ndocker rename "$candidate" "$service_name"', start)]
    script = '\n'.join([
        'set -Eeuo pipefail', 'candidate=fixture-candidate', 'release_sha=' + 'a' * 64,
        'docker() { if [ "$1" = inspect ]; then echo true; fi; }',
        'sleep() { :; }', 'seq() { echo "1 2 3"; }',
        'restore_previous() { echo previous-restored; }',
        'python3() { "$PYTHON_EXE" "$@"; }',
        '''curl() {
  if [[ "${*: -1}" == */version.json ]]; then
    printf \'{"release_sha":"%s"}\' "$release_sha"
  else
    "$PYTHON_EXE" -c \'
import json, os
from pathlib import Path
calls = Path(os.environ["HEALTH_CALLS"])
index = int(calls.read_text()) if calls.exists() else 0
calls.write_text(str(index + 1))
replies = json.loads(Path(os.environ["HEALTH_REPLIES"]).read_text())
print(json.dumps(replies[min(index, len(replies) - 1)]))
\'
  fi
}''',
        health_reader(), probe, 'echo candidate-ready'])
    result = run_bash(bash, script, HEALTH_REPLIES=str(reply_file), HEALTH_CALLS=str(calls))
    return result, int(calls.read_text())


def test_the_script_is_valid_bash(bash):
    done = run_bash(bash, SCRIPT.read_text(encoding='utf-8'), '-n')
    assert done.code == 0, done.err


@pytest.mark.parametrize('reply', ['refused', '<html>502 Bad Gateway</html>'])
def test_an_unreadable_health_stops_the_deploy(bash, reply):
    done = run_drain(bash, reply)
    assert done.code == 5 and UNREADABLE in done.err
    assert 'past-the-loop' not in done.out


@pytest.mark.parametrize('activity', [None, {}, [], 'idle',
    {"paid_requests": 0}, {"running_tasks": 0},
    *({"paid_requests": value, "running_tasks": 0} for value in (-1, False, None, "0", 0.0)),
    *({"paid_requests": 0, "running_tasks": value} for value in (-1, True, None, "0", 0.0)),
])
def test_missing_or_invalid_activity_cannot_prove_an_idle_release(bash, activity):
    done = run_drain(bash, json.dumps({"status": "healthy", "activity": activity, 'admission': ADMISSION}))
    assert done.code == 5 and UNREADABLE in done.err and 'past-the-loop' not in done.out


def test_health_without_activity_cannot_prove_an_idle_release(bash):
    done = run_drain(bash, '{"status":"healthy"}')
    assert done.code == 5 and UNREADABLE in done.err and 'past-the-loop' not in done.out


def test_an_unknown_drain_cannot_be_overridden(bash):
    done = run_drain(bash, 'refused', ALLOW_UNKNOWN_DRAIN='1')
    assert done.code == 5 and 'past-the-loop' not in done.out
    assert UNREADABLE in done.err


def test_only_one_allows_it(bash):
    assert run_drain(bash, 'refused', ALLOW_UNKNOWN_DRAIN='true').code == 5


def test_an_idle_release_is_replaced_without_a_word(bash):
    done = run_drain(bash, IDLE)
    assert done.code == 0 and 'past-the-loop' in done.out and done.err == ''


def test_a_busy_release_still_stops_the_deploy_after_the_drain_time(bash):
    done = run_drain(bash, BUSY, ALLOW_UNKNOWN_DRAIN='1')
    assert done.code == 4 and 'still has 1 paid or background tasks' in done.err


@pytest.mark.parametrize('health', [
    {}, {**READY, "status": "degraded"},
    {**READY, "connections": {"database": {"configured": True, "ok": None, "checking": True}}},
    {**READY, "connections": {"database": {"configured": True, "ok": False}}},
    {**READY, "connections": {"database": {"configured": True, "ok": 1}}},
    {**READY, "connections": {"database": {"configured": "true", "ok": True}}},
    {**READY, "connections": {}},
    {**READY, "activity": {}},
    {**READY, "activity": {"paid_requests": -1, "running_tasks": 0}},
    {**READY, "activity": {"paid_requests": 0, "running_tasks": False}},
    {**READY, 'admission': {**ADMISSION, 'draining': False}},
    {**READY, 'admission': {**ADMISSION, 'verified': False}},
    {**READY, 'admission': {}},
])
def test_an_unready_candidate_is_retried_then_rolled_back(bash, tmp_path, health):
    done, calls = run_candidate(bash, tmp_path, [health])
    assert calls == 3 and done.code == 1
    assert 'previous-restored' in done.out and 'candidate-ready' not in done.out
    assert 'candidate health check failed' in done.err


def test_candidate_waits_for_the_configured_database_to_answer(bash, tmp_path):
    checking = {**READY, "connections": {"database": {"configured": True, "ok": None, "checking": True}}}
    done, calls = run_candidate(bash, tmp_path, [checking, READY])
    assert calls == 2 and done.code == 0 and 'candidate-ready' in done.out
    assert 'previous-restored' not in done.out


def test_candidate_without_a_record_database_can_be_ready(bash, tmp_path):
    health = {**READY, "connections": {"database": {"configured": False, "ok": False}}}
    done, calls = run_candidate(bash, tmp_path, [health])
    assert calls == 1 and done.code == 0 and 'candidate-ready' in done.out


def test_the_studio_container_logs_are_rotated():
    text = SCRIPT.read_text(encoding='utf-8')
    start = text.index('docker run -d')
    run = text[start:text.index('\n  "$image" >/dev/null', start)]
    assert '--log-opt max-size=50m' in run and '--log-opt max-file=3' in run


FAKE_HOST = r'''
import json, os, sys
from pathlib import Path
root = Path(os.environ['FAKE_HOST_ROOT'])
state_path, events_path = root/'state.json', root/'events.jsonl'
state = json.loads(state_path.read_text())
family, args = sys.argv[1], sys.argv[2:]
def event(value):
    with events_path.open('a') as output:
        output.write(json.dumps(value) + '\n')
def save(): state_path.write_text(json.dumps(state))
def container(value):
    return next((item for item in state['containers'] if item['id'] == value or item['name'] == value), None)
if family == 'docker':
    command = args[0]
    event(['docker', *args])
    if command == 'image': sys.exit(0)
    if command == 'inspect':
        item = container(args[-1])
        if not item: sys.exit(1)
        if '-f' not in args: print('{}')
        elif 'Running' in args[2]: print(str(item['running']).lower())
        else: print(item['id'])
    elif command == 'rename': container(args[1])['name'] = args[2]; save()
    elif command == 'stop':
        assert state['draining'], 'old runtime was stopped with admission still open'
        container(args[-1])['running'] = False; save()
    elif command == 'start':
        item = container(args[-1]); item['running'] = True
        event(['restart-config', json.loads((root/'studio/provider.json').read_text())['revision']])
        save()
    elif command == 'rm':
        item = container(args[-1])
        if item: state['containers'].remove(item); save()
    elif command == 'run':
        state['containers'].append({'id': 'new-id', 'name': args[args.index('--name')+1], 'running': True})
        state['draining'] = True; save(); print('new-id')
        event(['candidate-admission', state['draining']])
    elif command == 'logs': print('fixture candidate unavailable')
elif family == 'curl':
    method = args[args.index('-X')+1] if '-X' in args else 'GET'
    event(['curl', method, args[-1]])
    if args[-1].endswith('/internal/drain'):
        if os.environ.get('FAKE_CONTROL') == 'unsupported': sys.exit(22)
        if method == 'DELETE' and container('new-id'):
            assert (root/'studio/current.json').exists(), 'candidate admission opened before release commit'
            assert json.loads((root/'studio/current.json').read_text())['sha256'] == 'a'*64
        state['draining'] = method == 'POST'; save()
        busy = int(os.environ.get('FAKE_DRAIN_BUSY', os.environ.get('FAKE_BUSY', '0')))
        print(json.dumps({'activity': {'paid_requests': busy, 'running_tasks': 0},
                          'admission': {'version': 1, 'verified': True, 'draining': state['draining']}}))
    elif args[-1].endswith('/version.json'):
        print(json.dumps({'release_sha': 'a'*64}))
    else:
        candidate = container('new-id')
        if 'FAKE_HEALTH' in os.environ:
            print(os.environ['FAKE_HEALTH']); sys.exit(0)
        ready = not candidate or os.environ.get('FAKE_READY') == '1'
        print(json.dumps({'status': 'healthy' if ready else 'degraded',
                          'activity': {'paid_requests': int(os.environ.get('FAKE_BUSY', '0')), 'running_tasks': 0},
                          'admission': {'version': 1, 'verified': True, 'draining': state['draining']},
                          'connections': {'database': {'configured': True, 'ok': ready}}}))
elif family == 'systemctl':
    event(['systemctl', *args])
    sys.exit(int(os.environ.get('FAKE_POWEROFF_EXIT', '0')))
'''


def run_host_deploy(bash, tmp_path, **env):
    """Run the entire deploy script against a disposable host and command doubles, never Docker/AWS."""
    root = tmp_path / 'host'
    source = root / 'studio/incoming' / ('a' * 64) / 'source'
    (source / 'infra').mkdir(parents=True)
    (source / 'infra/Dockerfile').write_text('FROM fixture')
    (source / 'infra/idle-stop.sh').write_text('#!/bin/bash\nexit 0\n')
    (source / '.release-sha256').write_text('a' * 64 + '\n')
    (root / 'studio/provider.json').write_text(json.dumps({'revision': 'old'}))
    (root / 'config.env').write_text('ASSET_S3_BUCKET=fixture\nAWS_REGION=fixture\nPROVIDER_SECRET_ARN=fixture\n')
    containers = [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]
    if env.get('FAKE_LEFTOVER'):
        name = ('gaesup-asset-studio-candidate-' + 'a'*12 if env['FAKE_LEFTOVER'] == 'candidate'
                else 'gaesup-asset-studio-rollback')
        containers.append({'id': 'leftover-id', 'name': name, 'running': True})
    (root / 'state.json').write_text(json.dumps({'draining': False, 'containers': containers}))
    fixture = root / 'commands.py'
    fixture.write_text(FAKE_HOST)
    text = SCRIPT.read_text(encoding='utf-8').replace('/opt/asset-studio', (root / 'studio').as_posix())
    text = text.replace('/etc/asset-studio.env', (root / 'config.env').as_posix())
    text = text.replace('/var/lock/asset-studio-deploy.lock', (root / 'deploy.lock').as_posix())
    text = text.replace('/var/log/asset-studio', (root / 'logs').as_posix())
    script = '\n'.join([
        'docker() { "$PYTHON_EXE" "$FAKE_COMMANDS" docker "$@"; '
        'if [[ "${FAKE_TERMINATE:-}" == 1 && "$1" == stop ]]; then kill -TERM $$; fi; }',
        'curl() { "$PYTHON_EXE" "$FAKE_COMMANDS" curl "$@"; }',
        'aws() { printf "%s" \'{"OPENAI_API_KEY":"offline","MESHY_API_KEY":"offline","revision":"new"}\'; }',
        'python3() { "$PYTHON_EXE" "$@"; }', 'sleep() { :; }', 'seq() { echo "1 2 3"; }',
        # A stub file descriptor lock: no other fake host shares this directory.
        'flock() { :; }', 'chmod() { :; }',
        'install() { shift 3; mkdir -p "$@"; }',
        'set -- "releases/studio/' + 'a'*64 + '.tar.gz" "' + 'a'*64 + '" "$FAKE_SOURCE"', text])
    done = run_bash(bash, script, FAKE_HOST_ROOT=str(root), FAKE_COMMANDS=str(fixture),
                    FAKE_SOURCE=source.as_posix(), ASSET_DEPLOY_DRAIN_SECONDS='0', **env)
    assert (root / 'events.jsonl').exists(), (done.code, done.out, done.err)
    events = [json.loads(line) for line in (root / 'events.jsonl').read_text().splitlines()]
    return done, json.loads((root / 'state.json').read_text()), events, root


def test_unsupported_old_runtime_is_left_running_without_a_stop_override(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_CONTROL='unsupported', ALLOW_UNKNOWN_DRAIN='1')
    assert done.code == 5 and 'left running' in done.err
    assert state['containers'] == [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]
    assert not any(event[:2] == ['docker', 'stop'] for event in events)
    assert json.loads((root / 'studio/provider.json').read_text())['revision'] == 'old'
    assert not list((root / 'studio').glob('provider.json.*'))


def test_a_busy_drain_reopens_admission_and_keeps_previous_configuration(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_BUSY='1')
    assert done.code == 4 and not state['draining']
    assert not any(event[:2] == ['docker', 'stop'] for event in events)
    assert events[-1][:2] == ['curl', 'DELETE']
    assert json.loads((root / 'studio/provider.json').read_text())['revision'] == 'old'


def test_a_failed_candidate_restores_old_container_configuration_and_admission(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path)
    assert done.code == 1 and 'previous container restored' in done.err
    assert state['containers'] == [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]
    assert not state['draining']
    assert ['restart-config', 'old'] in events
    assert events[-1][:2] == ['curl', 'DELETE']
    assert not list((root / 'studio').glob('provider.previous.*'))
    assert json.loads((root / 'studio/provider.json').read_text())['revision'] == 'old'


def test_termination_after_stopping_old_container_restores_it_and_reopens_admission(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_TERMINATE='1')
    assert done.code == 1
    assert state['containers'] == [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]
    assert not state['draining'] and ['restart-config', 'old'] in events
    assert events[-1][:2] == ['curl', 'DELETE']


def test_a_candidate_stays_closed_until_health_version_and_release_commit_pass(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_READY='1')
    assert done.code == 0 and 'deployment healthy' in done.out
    assert state['containers'] == [{'id': 'new-id', 'name': 'gaesup-asset-studio', 'running': True}]
    assert not state['draining'] and ['candidate-admission', True] in events
    renamed = next(index for index, event in enumerate(events) if event[:3] == ['docker', 'rename',
        'gaesup-asset-studio-candidate-' + 'a'*12])
    reopened = next(index for index, event in enumerate(events) if event[:2] == ['curl', 'DELETE'])
    assert renamed < reopened
    assert json.loads((root / 'studio/provider.json').read_text())['revision'] == 'new'


@pytest.mark.parametrize('leftover', ['candidate', 'rollback'])
def test_live_leftover_containers_are_preserved_for_recovery(bash, tmp_path, leftover):
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_LEFTOVER=leftover)
    assert done.code == 5
    assert all(item['running'] for item in state['containers'])
    assert any(item['id'] == 'leftover-id' for item in state['containers'])
    assert not any(event[0] == 'docker' and event[1] in ('stop', 'run') for event in events)
    assert json.loads((root / 'studio/provider.json').read_text())['revision'] == 'old'


IDLE_SCRIPT = SCRIPT.with_name('idle-stop.sh')


def run_idle_check(bash, tmp_path, **env):
    root = tmp_path / 'idle-host'
    root.mkdir()
    (root / 'state.json').write_text(json.dumps({'draining': False,
        'containers': [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]}))
    fixture = root / 'commands.py'
    fixture.write_text(FAKE_HOST)
    text = IDLE_SCRIPT.read_text(encoding='utf-8')
    for original, target in [('/var/log/asset-studio', 'logs'), ('/var/lib/asset-studio-idle', 'state'),
        ('/var/lock/asset-studio-deploy.lock', 'deploy.lock'), ('/var/lock/asset-studio-prepare.lock', 'prepare.lock')]:
        text = text.replace(original, (root / target).as_posix())
    script = '\n'.join([
        'docker() { "$PYTHON_EXE" "$FAKE_COMMANDS" docker "$@"; }',
        'curl() { "$PYTHON_EXE" "$FAKE_COMMANDS" curl "$@"; }',
        'systemctl() { "$PYTHON_EXE" "$FAKE_COMMANDS" systemctl "$@"; }',
        'python3() { "$PYTHON_EXE" "$@"; }', 'flock() { :; }',
        'install() { shift 3; mkdir -p "$@"; }',
        'cut() { echo 20000; }', 'date() { if [[ "$1" == +%s ]]; then echo 2000000000; else echo 1999980000; fi; }',
        text])
    done = run_bash(bash, script, FAKE_HOST_ROOT=str(root), FAKE_COMMANDS=str(fixture), **env)
    assert (root / 'events.jsonl').exists(), (done.code, done.out, done.err)
    events = [json.loads(line) for line in (root / 'events.jsonl').read_text().splitlines()]
    return done, json.loads((root / 'state.json').read_text()), events


def test_idle_poweroff_closes_admission_before_final_busy_observation(bash, tmp_path):
    done, state, events = run_idle_check(bash, tmp_path)
    assert done.code == 0 and 'powering off' in done.out and state['draining']
    assert events[-2][:2] == ['curl', 'POST'] and events[-1] == ['systemctl', 'poweroff']
    assert not any(event[:2] == ['curl', 'DELETE'] for event in events)


def test_work_admitted_between_idle_check_and_drain_prevents_poweroff(bash, tmp_path):
    done, state, events = run_idle_check(bash, tmp_path, FAKE_DRAIN_BUSY='1')
    assert done.code == 0 and 'admitted before drain' in done.out and not state['draining']
    assert events[-1][:2] == ['curl', 'DELETE']
    assert not any(event[0] == 'systemctl' for event in events)


@pytest.mark.parametrize('invalid', [
    '{}', json.dumps({'activity': {'paid_requests': -1, 'running_tasks': 0}, 'admission': ADMISSION}),
    json.dumps({'activity': {'paid_requests': False, 'running_tasks': 0}, 'admission': ADMISSION}),
    json.dumps({'activity': {'paid_requests': 0, 'running_tasks': 0}, 'admission': {**ADMISSION, 'verified': False}}),
])
def test_idle_poweroff_is_refused_for_unknown_activity(bash, tmp_path, invalid):
    done, state, events = run_idle_check(bash, tmp_path, FAKE_HEALTH=invalid)
    assert done.code == 0 and 'could not be read' in done.out and not state['draining']
    assert not any(event[0] == 'systemctl' for event in events)


def test_a_failed_poweroff_reopens_admission(bash, tmp_path):
    done, state, events = run_idle_check(bash, tmp_path, FAKE_POWEROFF_EXIT='1')
    assert done.code == 1 and not state['draining']
    assert events[-2] == ['systemctl', 'poweroff'] and events[-1][:2] == ['curl', 'DELETE']


def test_an_old_runtime_without_drain_is_never_powered_off(bash, tmp_path):
    done, state, events = run_idle_check(bash, tmp_path, FAKE_CONTROL='unsupported')
    assert done.code == 0 and 'drain could not be verified' in done.out
    assert not any(event[0] == 'systemctl' for event in events)
