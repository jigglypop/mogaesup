import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from shell_harness import LINUX_FILE_COMMANDS, portable_idle_script, replace_host_paths

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
        'budget_left() { echo "${FAKE_BUDGET:-86400}"; }', 'replace_seconds=240',
        health_reader(), drain_loop(), 'echo past-the-loop'])
    return run_bash(bash, script, FAKE_REPLY=reply, ASSET_DEPLOY_DRAIN_SECONDS=env.pop('drain', '0'), **env)


def run_candidate(bash, tmp_path, replies, **env):
    """Exercise the real candidate wait and rollback decision with successive health replies."""
    reply_file = tmp_path / 'replies.json'
    calls = tmp_path / 'health-calls'
    reply_file.write_text(json.dumps(replies), encoding='utf-8')
    text = SCRIPT.read_text(encoding='utf-8')
    start = text.index('healthy=false')
    probe = text[start:text.index('\ndocker rename "$candidate" "$service_name"', start)]
    script = '\n'.join([
        'set -Eeuo pipefail', 'candidate=fixture-candidate', 'release_sha=' + 'a' * 64,
        'start_dir=/nonexistent-start-token-dir', 'PUBLIC_STUDIO=false',
        'docker() { if [ "$1" = inspect ]; then echo true; fi; }',
        'sleep() { :; }', 'seq() { echo "1 2 3"; }',
        'restore_previous() { echo previous-restored; }',
        'python3() { "$PYTHON_EXE" "$@"; }',
        'budget_left() { echo "${FAKE_BUDGET:-86400}"; }', 'rollback_seconds=120',
        '''curl() {
  if [[ "${*: -1}" == */version.json ]]; then
    printf \'{"release_sha":"%s"}\' "$release_sha"
  elif [[ "${*: -1}" == http://127.0.0.1/api/health ]]; then
    printf 403
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
    result = run_bash(bash, script, HEALTH_REPLIES=str(reply_file), HEALTH_CALLS=str(calls), **env)
    return result, int(calls.read_text()) if calls.exists() else 0


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
# The commands answer as on Linux: no carriage returns before line ends.
sys.stdout.reconfigure(newline=chr(10))
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
    if command == 'image':
        if args[1] == 'ls':
            print('\n'.join(state.get('images', [])))
        elif args[1] == 'rm':
            state['images'] = [line for line in state.get('images', []) if line.split('|')[1] != args[-1]]; save()
        sys.exit(0)
    if command == 'inspect':
        # As docker does: an answer per container found, and a failure when any is missing.
        form = args[args.index('-f') + 1] if '-f' in args else None
        names = args[args.index('-f') + 2:] if form else args[1:]
        found = [container(name) for name in names]
        for item in filter(None, found):
            if form is None: print('{}')
            elif 'Running' in form: print(str(item['running']).lower())
            elif 'Labels' in form: print(item.get('start_id', ''))
            else: print(item['id'])
        if not all(found): sys.exit(1)
    elif command == 'rename': container(args[1])['name'] = args[2]; save()
    elif command == 'stop':
        item = container(args[-1])
        assert state['draining'] or not item['running'], 'old runtime was stopped with admission still open'
        item['running'] = False; save()
    elif command == 'start':
        item = container(args[-1]); item['running'] = True
        # uvicorn listens only once its startup has finished.
        state['refusals'] = int(os.environ.get('FAKE_START_DELAY', '0'))
        event(['restart-config', json.loads((root/'studio/provider.json').read_text())['revision']])
        save()
    elif command == 'rm':
        item = container(args[-1])
        if item: state['containers'].remove(item); save()
    elif command == 'run' and '--rm' in args:
        # The record database migration in the new image, before anything is stopped.
        event(['migrate', state['draining'], [item['name'] for item in state['containers'] if item['running']]])
        print('applied 004_fixture.up.sql\nrecord schema ready')
        sys.exit(int(os.environ.get('FAKE_MIGRATE_EXIT', '0')))
    elif command == 'run':
        assert args[args.index('--restart') + 1] == 'no', 'an unverified candidate must not be restarted by Docker'
        assert not any(value.startswith('ASSET_START_DRAIN_TOKEN=') for value in args), 'the token must not be in the env'
        mount = next(value for value in args if value.startswith('type=bind,source='))
        token = (Path(mount.split('source=', 1)[1].split(',')[0]) / 'token').read_text().strip()
        start_id = next(value.split('=', 1)[1] for value in args if value.startswith('gaesup.start.id='))
        if state.get('drain_owner') not in (None, token):
            # The runtime refuses to start: another operation owns admission.
            state['containers'].append({'id': 'new-id', 'name': args[args.index('--name')+1], 'running': False})
            save(); print('new-id'); event(['candidate-refused', state['drain_owner']]); sys.exit(0)
        state['containers'].append({'id': 'new-id', 'name': args[args.index('--name')+1], 'running': True,
                                    'start_id': start_id})
        state.update(draining=True, drain_owner=token); save(); print('new-id')
        event(['candidate-admission', state['draining']])
    elif command == 'logs': print('fixture candidate unavailable')
elif family == 'curl':
    method = args[args.index('-X')+1] if '-X' in args else 'GET'
    event(['curl', method, args[-1]])
    write_out = '--write-out' in args
    def answer(status, body):
        if write_out:
            sys.stdout.write(body + '\n' + str(status)); sys.exit(0)
        if '--fail' in args and status >= 400: sys.exit(22)
        print(body); sys.exit(0)
    if state.get('refusals'):
        state['refusals'] -= 1; save(); event(['refused', method])
        if write_out: sys.stdout.write('\n000')
        sys.exit(7)
    if args[-1].endswith('/internal/drain'):
        if os.environ.get('FAKE_CONTROL') == 'unsupported': answer(404, '{"detail":"Not Found"}')
        data = args[args.index('--data')+1]
        assert data == '@-', 'the drain token must not be on the command line'
        token = json.loads(sys.stdin.read())['token']
        if state.get('drain_owner') not in (None, token):
            answer(409, '{"detail":"Runtime admission state cannot be changed"}')
        if method == 'DELETE' and container('new-id'):
            assert (root/'studio/current.json').exists(), 'candidate admission opened before release commit'
            assert json.loads((root/'studio/current.json').read_text())['sha256'] == 'a'*64
        state['draining'] = method == 'POST'
        state['drain_owner'] = token if method == 'POST' else None
        save()
        busy = int(os.environ.get('FAKE_DRAIN_BUSY', os.environ.get('FAKE_BUSY', '0')))
        answer(200, json.dumps({'activity': {'paid_requests': busy, 'running_tasks': 0},
                                'admission': {'version': 1, 'verified': True, 'draining': state['draining']}}))
    elif args[-1].endswith('/version.json'):
        print(json.dumps({'release_sha': 'a'*64}))
    elif args[-1] == 'http://127.0.0.1/api/health':
        # Port 80: with the gateway key (a header file) or without it.
        header = args[args.index('-H') + 1] if '-H' in args else ''
        if header.startswith('@'):
            assert Path(header[1:]).read_text().startswith('x-gateway-key: ')
            answer(int(os.environ.get('FAKE_KEYED_STATUS', '200')), '')
        answer(200 if os.environ.get('FAKE_GATE_OPEN') == '1' else 403, '')
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
elif family == 'aws':
    if args[0] == 'secretsmanager':
        sys.stdout.write(os.environ['FAKE_SECRET_PAYLOAD'])
    else:
        event(['aws', *args[:2], args[args.index('--value') + 1] if '--value' in args else None])
'''


def run_host_deploy(bash, tmp_path, *, root=None, database=False, interrupted=False, **env):
    """Run the entire deploy script against a disposable host and command doubles, never Docker/AWS. Passing the `root`
    of an earlier run deploys again on that host, as the next deployment would."""
    again = root is not None
    root = root or tmp_path / 'host'
    source = root / 'studio/incoming' / ('a' * 64) / 'source'
    (source / 'infra').mkdir(parents=True, exist_ok=True)
    (source / 'infra/Dockerfile').write_text('FROM fixture')
    (source / 'infra/idle-stop.sh').write_text('#!/bin/bash\nexit 0\n')
    (source / '.release-sha256').write_text('a' * 64 + '\n')
    if not again:
        (root / 'studio/provider.json').write_text(json.dumps({'revision': 'old'}))
    if interrupted:
        # A deployment killed after it installed its configuration: the copy of the running release's is left behind.
        (root / 'studio/provider.previous.json').write_text(json.dumps({'revision': 'old'}))
        (root / 'studio/provider.json').write_text(json.dumps({'revision': 'interrupted'}))
    (root / 'config.env').write_text('ASSET_S3_BUCKET=fixture\nAWS_REGION=ap-northeast-2\nPROVIDER_SECRET_ARN=fixture\n'
                                   + 'PUBLIC_STUDIO=' + env.pop('FAKE_PUBLIC', 'false') + '\n')
    secret = {'OPENAI_API_KEY': 'offline', 'MESHY_API_KEY': 'offline', 'revision': 'new'}
    if 'FAKE_GATEWAY_KEY' in env:
        secret['STUDIO_GATEWAY_KEY'] = env.pop('FAKE_GATEWAY_KEY')
    if database:
        secret['CHARACTER_DATABASE_URL'] = 'postgresql://fixture'
    containers = {'running': [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}],
                  'stopped': [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': False}],
                  'none': []}[env.pop('FAKE_OLD', 'running')]
    if env.get('FAKE_LEFTOVER'):
        name = ('gaesup-asset-studio-candidate-' + 'a'*12 if env['FAKE_LEFTOVER'] == 'candidate'
                else 'gaesup-asset-studio-rollback')
        containers.append({'id': 'leftover-id', 'name': name, 'running': True})
    if env.pop('FAKE_ROLLBACK_STOPPED', None):
        containers.append({'id': 'old-id', 'name': 'gaesup-asset-studio-rollback', 'running': False})
    if again:
        state = json.loads((root / 'state.json').read_text())
        # The runtime that did not answer before has started listening by now.
        state['containers'] = [item for item in state['containers'] if item['id'] != 'new-id']
        state['refusals'] = 0
        (root / 'state.json').write_text(json.dumps(state))
        (root / 'events.jsonl').unlink(missing_ok=True)
    else:
        (root / 'state.json').write_text(json.dumps({'draining': False, 'drain_owner': env.pop('FAKE_DRAIN_OWNER', None),
                                                     'containers': containers, 'images': env.pop('FAKE_IMAGES', [])}))
    fixture = root / 'commands.py'
    fixture.write_text(FAKE_HOST)
    text = replace_host_paths(SCRIPT.read_text(encoding='utf-8'), {
        '/opt/asset-studio': (root/'studio').as_posix(), '/etc/asset-studio.env': (root/'config.env').as_posix(),
        '/var/lock/asset-studio-deploy.lock': (root/'deploy.lock').as_posix(),
        '/var/log/asset-studio': (root/'logs').as_posix()})
    script = '\n'.join([
        # The exit status of the fake command, as `docker inspect` of a missing container fails.
        'docker() { local code=0; "$PYTHON_EXE" "$FAKE_COMMANDS" docker "$@" || code=$?; '
        'if [[ "${FAKE_TERMINATE:-}" == 1 && "$1" == stop ]]; then kill -TERM $$; fi; return $code; }',
        'curl() { "$PYTHON_EXE" "$FAKE_COMMANDS" curl "$@"; }',
        'aws() { "$PYTHON_EXE" "$FAKE_COMMANDS" aws "$@"; }', 'timeout() { shift 2; "$@"; }',
        'python3() { "$PYTHON_EXE" "$@"; }', 'sleep() { :; }', 'seq() { echo "1 2 3"; }',
        # A stub file descriptor lock: no other fake host shares this directory.
        'flock() { :; }', 'chmod() { :; }',
        'install() { shift 3; mkdir -p "$@"; }',
        'set -- "releases/studio/' + 'a'*64 + '.tar.gz" "' + 'a'*64 + '" "$FAKE_SOURCE"', text])
    done = run_bash(bash, script, FAKE_HOST_ROOT=str(root), FAKE_COMMANDS=str(fixture),
                    FAKE_SOURCE=source.as_posix(), FAKE_SECRET_PAYLOAD=json.dumps(secret), ASSET_DEPLOY_DRAIN_SECONDS='0', **env)
    events = [json.loads(line) for line in (root / 'events.jsonl').read_text().splitlines()] if (root / 'events.jsonl').exists() else []
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


@pytest.mark.parametrize('key', [None, 'short', 'punctuation+invalid/key='])
def test_invalid_public_gateway_configuration_is_rejected_before_closing_the_running_release(bash, tmp_path, key):
    env = {'FAKE_PUBLIC': 'true'}
    if key is not None:
        env['FAKE_GATEWAY_KEY'] = key
    done, state, events, root = run_host_deploy(bash, tmp_path, **env)
    assert done.code != 0 and 'valid STUDIO_GATEWAY_KEY' in done.err
    assert state['containers'] == [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]
    assert not state['draining'] and not events
    assert json.loads((root / 'studio/provider.json').read_text())['revision'] == 'old'
    assert not list((root / 'studio').glob('provider.json.*'))


def test_valid_public_gateway_configuration_can_reach_the_normal_closed_candidate_deploy(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_PUBLIC='true', FAKE_GATEWAY_KEY='a'*32, FAKE_READY='1')
    assert done.code == 0 and 'deployment healthy' in done.out
    assert not state['draining'] and ['candidate-admission', True] in events


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
    assert [{key: item[key] for key in ('id', 'name', 'running')} for item in state['containers']] == [
        {'id': 'new-id', 'name': 'gaesup-asset-studio', 'running': True}]
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


TOKEN = 'b' * 32


def token_file(root):
    return root / 'studio/drain-token'


def test_a_rollback_retries_the_reopen_until_the_restored_runtime_listens(bash, tmp_path):
    # The restored container refuses connections while uvicorn starts; one refused DELETE must not leave it closed.
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_START_DELAY='3')
    assert done.code == 1 and 'previous container restored' in done.err
    assert not state['draining'] and state['drain_owner'] is None
    assert [event for event in events if event[0] == 'refused'] == [['refused', 'DELETE']] * 3
    assert events[-1][:2] == ['curl', 'DELETE'] and not token_file(root).exists()
    assert 'could not' not in done.err and 'did not answer' not in done.err


def test_a_restored_runtime_that_never_answers_keeps_its_token_for_the_next_deployment(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_START_DELAY='1000', ASSET_DEPLOY_REOPEN_SECONDS='0')
    assert done.code == 1 and 'did not answer the admission reopen' in done.err
    owner = state['drain_owner']
    assert state['draining'] and token_file(root).read_text().strip() == owner
    # The next deployment resumes that drain with the same token instead of meeting an unknown owner.
    again, state, events, root = run_host_deploy(bash, tmp_path, root=root, FAKE_READY='1')
    assert again.code == 0 and 'deployment healthy' in again.out
    assert not state['draining'] and not token_file(root).exists()
    assert ['candidate-admission', True] in events


def test_a_failed_first_deployment_leaves_admission_resumable_by_the_next(bash, tmp_path):
    # No runtime ran: the candidate closed admission with the token, and nothing is left to reopen it.
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_OLD='none')
    assert done.code == 1 and 'no runtime is running to reopen admission' in done.err
    assert state['drain_owner'] == token_file(root).read_text().strip()
    again, state, events, root = run_host_deploy(bash, tmp_path, root=root, FAKE_READY='1')
    assert again.code == 0 and 'deployment healthy' in again.out
    assert not any(event[0] == 'candidate-refused' for event in events)
    assert not state['draining'] and state['drain_owner'] is None and not token_file(root).exists()


def test_a_stopped_runtime_restored_after_a_failed_candidate_is_reopened(bash, tmp_path):
    # The service was down at deploy start, so no drain was requested, but the candidate closed admission.
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_OLD='stopped')
    assert done.code == 1 and 'previous container restored' in done.err
    assert state['containers'] == [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]
    assert not state['draining'] and state['drain_owner'] is None and not token_file(root).exists()
    assert events[-1][:2] == ['curl', 'DELETE']


def test_a_drain_owned_by_another_operation_is_named_and_left_alone(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_DRAIN_OWNER=TOKEN)
    assert done.code == 6 and 'already closed by another operation' in done.err
    assert 'does not support' not in done.err
    assert state['drain_owner'] == TOKEN and not token_file(root).exists()
    assert not any(event[:2] in (['docker', 'stop'], ['docker', 'run'], ['curl', 'DELETE']) for event in events)
    assert json.loads((root / 'studio/provider.json').read_text())['revision'] == 'old'


def test_a_runtime_that_starts_listening_late_is_drained_once_it_answers(bash, tmp_path):
    # The stable name is recovered from a stopped rollback container, which needs a moment before uvicorn listens.
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_OLD='none', FAKE_ROLLBACK_STOPPED='1',
                                                FAKE_START_DELAY='2', FAKE_READY='1')
    assert done.code == 0 and 'deployment healthy' in done.out
    assert [event for event in events if event[0] == 'refused'] == [['refused', 'POST']] * 2
    assert not state['draining'] and not token_file(root).exists()


@pytest.mark.parametrize('budget, ran', [(100, False), (400, True)])
def test_admission_is_closed_only_when_the_time_limit_covers_the_replacement_and_a_rollback(bash, tmp_path, budget, ran):
    import time
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_READY='1',
                                                ASSET_DEPLOY_DEADLINE=str(int(time.time()) + budget))
    if ran:
        assert done.code == 0 and 'deployment healthy' in done.out
    else:
        assert done.code == 7 and 'too few to drain, replace and roll back' in done.err
        assert not any(event[0] == 'curl' or event[:2] in (['docker', 'stop'], ['docker', 'run']) for event in events)
        assert state['containers'] == [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]
        assert not state['draining'] and not token_file(root).exists()


def test_the_drain_wait_is_cut_to_what_the_time_limit_leaves(bash):
    # 420 s of drain time, but only 240 s left, all of them for the replacement: the busy release stops the deploy now.
    done = run_drain(bash, BUSY, drain='420', FAKE_BUDGET='240')
    assert done.code == 4 and 'still has 1 paid or background tasks' in done.err


def test_the_candidate_wait_ends_while_a_rollback_still_fits(bash, tmp_path):
    done, calls = run_candidate(bash, tmp_path, [READY], FAKE_BUDGET='100')
    assert calls == 0 and done.code == 1 and 'previous-restored' in done.out


def test_an_invalid_deadline_stops_before_anything(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, ASSET_DEPLOY_DEADLINE='soon')
    assert done.code == 2 and 'invalid ASSET_DEPLOY_DEADLINE' in done.err and not events


def test_a_successful_deployment_keeps_the_newest_three_releases(bash, tmp_path):
    import time
    root = tmp_path / 'host'
    releases = root / 'studio/releases'
    old = [str(index) * 64 for index in range(1, 6)]
    for age, name in enumerate(old):
        (releases / name).mkdir(parents=True)
        os.utime(releases / name, (time.time() - 1000 + age * 10,) * 2)
    (root / 'studio/incoming' / ('9' * 64) / 'source').mkdir(parents=True)
    images = [f'2026-10-0{day} 10:00:00 +0000 UTC|gaesup-asset-studio:{name}' for day, name in
              zip((1, 2, 3, 4, 5), old)] + ['2026-10-06 10:00:00 +0000 UTC|gaesup-asset-studio:' + 'a' * 64]
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_READY='1', FAKE_IMAGES=images)
    assert done.code == 0 and 'deployment healthy' in done.out
    assert sorted(path.name for path in releases.iterdir()) == sorted(['a' * 64, old[4], old[3]])
    assert [line.split(':')[-1] for line in state['images']] == [old[3], old[4], 'a' * 64]
    assert not (root / 'studio/incoming' / ('9' * 64)).exists()
    assert ['docker', 'image', 'prune', '-f'] in events


def test_a_verified_candidate_is_restarted_by_docker_only_after_its_checks(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_READY='1')
    assert done.code == 0 and 'deployment healthy' in done.out
    update = events.index(['docker', 'update', '--restart', 'unless-stopped', 'gaesup-asset-studio-candidate-' + 'a'*12])
    gate = events.index(['curl', 'GET', 'http://127.0.0.1/api/health'])
    renamed = events.index(['docker', 'rename', 'gaesup-asset-studio-candidate-' + 'a'*12, 'gaesup-asset-studio'])
    assert gate < update < renamed
    # The release a later stack update has to pass, recorded once it is committed.
    recorded = events.index(['aws', 'ssm', 'put-parameter', 'releases/studio/' + 'a'*64 + '.tar.gz'])
    assert renamed < recorded


def test_a_candidate_whose_public_port_answers_without_the_key_is_rolled_back(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_READY='1', FAKE_GATE_OPEN='1')
    assert done.code == 1 and 'port 80 answered HTTP 200' in done.err
    assert state['containers'] == [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]
    assert not state['draining'] and ['restart-config', 'old'] in events
    assert not any(event[:2] == ['docker', 'update'] for event in events)
    assert json.loads((root / 'studio/provider.json').read_text())['revision'] == 'old'


def test_the_startup_token_is_a_file_that_goes_once_applied(bash, tmp_path):
    stale = tmp_path / 'host/studio/start-tokens' / ('9' * 32)
    stale.mkdir(parents=True)
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_READY='1')
    assert done.code == 0 and 'deployment healthy' in done.out
    (service,) = state['containers']
    folders = list((root / 'studio/start-tokens').iterdir())
    # The running container's folder stays for its restarts, without the token; folders of gone containers go.
    assert [folder.name for folder in folders] == [service['start_id']]
    assert not (folders[0] / 'token').exists() and not stale.exists()


def test_a_public_candidate_that_refuses_the_gateway_key_is_rolled_back(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_PUBLIC='true', FAKE_GATEWAY_KEY='a' * 32,
                                                FAKE_READY='1', FAKE_KEYED_STATUS='403')
    assert done.code == 1 and 'port 80 answered HTTP 403 to a request with the gateway key' in done.err
    assert state['containers'] == [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]
    assert not list((root / 'studio').glob('gateway-header.*'))
    assert 'a' * 32 not in done.out + done.err


def test_a_release_folder_with_another_hash_rolls_back_instead_of_stopping_half_way(bash, tmp_path):
    release = tmp_path / 'host/studio/releases' / ('a' * 64)
    release.mkdir(parents=True)
    (release / '.release-sha256').write_text('b' * 64 + '\n')
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_READY='1')
    assert done.code == 1 and 'mismatched hash marker' in done.err
    assert state['containers'] == [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]
    assert not state['draining'] and json.loads((root / 'studio/provider.json').read_text())['revision'] == 'old'
    assert not (root / 'studio/current.json').exists() and not (root / 'studio/provider.previous.json').exists()


def test_the_record_database_is_migrated_before_anything_is_stopped(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, database=True, FAKE_READY='1')
    assert done.code == 0 and 'deployment healthy' in done.out and 'applied 004_fixture.up.sql' in done.out
    migrated = next(index for index, event in enumerate(events) if event[0] == 'migrate')
    # The running release still serves, with admission open, while the schema only grows.
    assert events[migrated][1:] == [False, ['gaesup-asset-studio']]
    drained = next(index for index, event in enumerate(events) if event[:2] == ['curl', 'POST'])
    assert migrated < drained


def test_a_failed_migration_leaves_the_running_release_alone(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, database=True, FAKE_READY='1', FAKE_MIGRATE_EXIT='1')
    assert done.code == 8 and 'record database migration failed' in done.err
    assert 'postgresql://' not in done.out + done.err
    assert state['containers'] == [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]
    assert not state['draining']
    assert not any(event[:2] in (['docker', 'stop'], ['curl', 'POST']) or event[:3] == ['docker', 'run', '-d']
                   for event in events)
    assert json.loads((root / 'studio/provider.json').read_text())['revision'] == 'old'


def test_without_a_record_database_nothing_is_migrated(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, FAKE_READY='1')
    assert done.code == 0 and not any(event[0] == 'migrate' for event in events)


def test_an_interrupted_deployment_gets_its_runtime_and_configuration_back(bash, tmp_path):
    # Killed after stopping the old runtime (no EXIT trap): only the rollback container and the copied configuration remain.
    done, state, events, root = run_host_deploy(bash, tmp_path, interrupted=True, FAKE_OLD='none', FAKE_ROLLBACK_STOPPED='1')
    assert 'restored the configuration an interrupted deployment had replaced' in done.err
    # The old runtime restarts with its own configuration, then this deployment's failed candidate restores it again.
    assert next(event for event in events if event[0] == 'restart-config') == ['restart-config', 'old']
    assert done.code == 1 and state['containers'] == [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]
    assert json.loads((root / 'studio/provider.json').read_text())['revision'] == 'old'
    assert not (root / 'studio/provider.previous.json').exists()


def test_an_interrupted_deployment_that_left_the_old_runtime_running_restores_its_configuration(bash, tmp_path):
    done, state, events, root = run_host_deploy(bash, tmp_path, interrupted=True, FAKE_BUSY='1')
    assert done.code == 4 and 'restored the configuration' in done.err
    assert json.loads((root / 'studio/provider.json').read_text())['revision'] == 'old'
    assert not (root / 'studio/provider.previous.json').exists()


IDLE_SCRIPT = SCRIPT.with_name('idle-stop.sh')


def run_idle_check(bash, tmp_path, **env):
    root = tmp_path / 'idle-host'
    root.mkdir()
    (root / 'state.json').write_text(json.dumps({'draining': False,
        'containers': [{'id': 'old-id', 'name': 'gaesup-asset-studio', 'running': True}]}))
    fixture = root / 'commands.py'
    fixture.write_text(FAKE_HOST)
    text = portable_idle_script(replace_host_paths(IDLE_SCRIPT.read_text(encoding='utf-8'), {
        original: (root/target).as_posix() for original, target in [('/var/log/asset-studio', 'logs'),
        ('/var/lib/asset-studio-idle', 'state'), ('/var/lock/asset-studio-deploy.lock', 'deploy.lock'),
        ('/var/lock/asset-studio-prepare.lock', 'prepare.lock')]}))
    script = '\n'.join([
        'docker() { "$PYTHON_EXE" "$FAKE_COMMANDS" docker "$@"; }',
        'curl() { "$PYTHON_EXE" "$FAKE_COMMANDS" curl "$@"; }',
        'systemctl() { "$PYTHON_EXE" "$FAKE_COMMANDS" systemctl "$@"; }',
        'python3() { "$PYTHON_EXE" "$@"; }', 'flock() { :; }',
        LINUX_FILE_COMMANDS,
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


@pytest.mark.parametrize('setting', ['off', 'on'])
def test_the_activity_log_is_kept_small_even_with_idle_stop_off(bash, tmp_path, setting):
    root = tmp_path / 'idle-host'
    (root / 'logs').mkdir(parents=True)
    log = root / 'logs/activity.log'
    log.write_bytes(b''.join(b'%d 200 GET /api/studio/catalog\n' % index for index in range(400_000)))
    assert log.stat().st_size > 8 * 1024 * 1024
    os.utime(log, (1_900_000_000, 1_900_000_000))
    text = portable_idle_script(replace_host_paths(IDLE_SCRIPT.read_text(encoding='utf-8'), {
        original: (root/target).as_posix() for original, target in [('/var/log/asset-studio', 'logs'),
        ('/var/lib/asset-studio-idle', 'state'), ('/var/lock/asset-studio-deploy.lock', 'deploy.lock'),
        ('/var/lock/asset-studio-prepare.lock', 'prepare.lock')]}))
    script = '\n'.join(['install() { shift 3; mkdir -p "$@"; }', 'flock() { :; }', LINUX_FILE_COMMANDS,
                        # Inside the boot grace, so the "on" run stops before it would read the API.
                        'cut() { echo 60; }', text])
    done = run_bash(bash, script, IDLE_STOP=setting)
    assert done.code == 0 and 'keeping on' in done.out
    lines = log.read_bytes().splitlines()
    assert len(lines) == 1000 and lines[-1] == b'399999 200 GET /api/studio/catalog'
    assert int(log.stat().st_mtime) == 1_900_000_000
