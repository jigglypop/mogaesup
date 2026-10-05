#!/usr/bin/env python3
"""One reviewed legacy release only: close network admission, prove idle, send TERM, never KILL.

Run as the sole maintenance operator after the next release archive/image is prepared. Do not launch CLI or SSM
sessions during this operation. A successful stop leaves idle shutdown disabled for the immediately following normal
deploy, which installs its safe timer. A failure before TERM restores admission and the previous timer state.
"""
import argparse
from contextlib import ExitStack
import http.client
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import subprocess
import sys
import time
import uuid

LEGACY_RELEASE = '971e9eebd0937efa37e8d91eae67d7b8c8031e3ff0a44ed33dd0b1417a4ac4b2'
LEGACY_ACTIVITY = 'e1e9b5e0cb1e0b9a0efeca348f1e0eb4d452599af242a5bb545afc63e3cda527'
SERVICE = 'gaesup-asset-studio'
IDLE_TIMER = 'asset-studio-idle.timer'
RECEIPT = Path('/opt/asset-studio/legacy-maintenance.json')
PROOF = '''
import ast,hashlib,json,os,pathlib
from src.services import runtime_activity
from src.services.process_identity import state
source=pathlib.Path(runtime_activity.__file__).read_bytes()
server=ast.parse(pathlib.Path('/app/backend/src/api/server.py').read_text())
installed=any(isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='add_middleware'
 and n.args and isinstance(n.args[0],ast.Name) and n.args[0].id=='ActivityMiddleware' for n in ast.walk(server))
entry=ast.parse(pathlib.Path('/app/entrypoint.py').read_text())
allowed=next(ast.literal_eval(n.value) for n in entry.body if isinstance(n,ast.Assign)
 and any(isinstance(t,ast.Name) and t.id=='allowed' for t in n.targets))
runners=[state(json.loads(p.read_text()).get('process')) for p in pathlib.Path('/app/data').rglob('runner.json')]
print(json.dumps({'sha':hashlib.sha256(source).hexdigest(),'installed':installed,
 'auto_resume':os.getenv('ASSET_AUTO_RESUME','').strip().lower() in ('1','true','yes'),
 'secret_auto_resume':'ASSET_AUTO_RESUME' in allowed,'runners':runners}))
'''


class Unsafe(RuntimeError):
    pass


def checked_activity(value):
    """Only the reviewed legacy contract can prove idle; never coerce missing or malformed counters."""
    try:
        counts = [value['activity'][key] for key in ('paid_requests', 'running_tasks')]
        database = value['connections']['database']
        pid = value['runtime']['pid']
        if (value['status'] != 'healthy' or any(type(n) is not int or n < 0 for n in counts)
                or type(database['configured']) is not bool
                or (database['configured'] and database.get('ok') is not True)
                or type(pid) is not int or pid <= 0):
            raise ValueError()
        return sum(counts), pid
    except (KeyError, TypeError, ValueError, AttributeError):
        raise Unsafe('legacy activity or database readiness cannot be verified') from None


def foreign_api_sockets(lines, health_port):
    """Include half-open connections; exclude only LISTEN, CLOSED, TIME_WAIT and our health connection pair."""
    for line in lines.splitlines()[1:]:
        values = line.split()
        local, remote, state = values[1:4]
        local_port, remote_port = int(local.rsplit(':', 1)[1], 16), int(remote.rsplit(':', 1)[1], 16)
        if state in ('06', '07', '0A') or 8000 not in (local_port, remote_port):
            continue
        if not (local.split(':', 1)[0] == remote.split(':', 1)[0] == '0100007F'
                and {local_port, remote_port} == {8000, health_port}):
            return True
    return False


class Host:
    clock = staticmethod(time.monotonic)
    sleep = staticmethod(time.sleep)

    def __init__(self):
        self.connection = None
        self.tag = 'studio-legacy-' + uuid.uuid4().hex
        self.gate_installed = False

    def command(self, *args, check=True):
        result = subprocess.run(args, capture_output=True, text=True, timeout=20)
        if check and result.returncode:
            raise Unsafe(f'{args[0]} {args[1]} failed; inspect locally without printing credentials')
        return result

    def metadata(self):
        value = json.loads(self.command('docker', 'inspect', SERVICE).stdout)[0]
        env = dict(item.partition('=')[::2] for item in value['Config']['Env'])
        if (value['Config']['Image'] != f'gaesup-asset-studio:{LEGACY_RELEASE}'
                or env.get('STUDIO_RELEASE_SHA') != LEGACY_RELEASE or not value['State']['Running']
                or value['HostConfig']['NetworkMode'] != 'host'
                or env.get('ASSET_DATA_ROOT') != '/app/data'
                or value['HostConfig']['RestartPolicy']['Name'] != 'unless-stopped'
                or not any(m['Source'] == '/opt/asset-studio/scratch' and m['Destination'] == '/app/data'
                           and m['RW'] is True for m in value['Mounts'])):
            raise Unsafe('runtime does not match the reviewed legacy release and host-network layout')
        return {'container_id': value['Id'], 'restart_policy': 'unless-stopped', 'release_sha': LEGACY_RELEASE}

    def proof(self):
        value = json.loads(self.command('docker', 'exec', SERVICE, 'python', '-c', PROOF).stdout)
        if (value.get('sha') != LEGACY_ACTIVITY or value.get('installed') is not True
                or value.get('auto_resume') is not False or value.get('secret_auto_resume') is not False
                or not isinstance(value.get('runners'), list) or any(s != 'exited' for s in value['runners'])):
            raise Unsafe('legacy counter source, auto-resume or runner identity is uncertain')
        return {'activity_sha256': value['sha'], 'runner_count': len(value['runners'])}

    def timer_active(self):
        return self.command('systemctl', 'is-active', '--quiet', IDLE_TIMER, check=False).returncode == 0

    def stop_timer(self):
        self.command('systemctl', 'stop', IDLE_TIMER)
        result = self.command('systemctl', 'is-active', 'asset-studio-idle.service', check=False)
        if result.stdout.strip() not in ('inactive', 'failed'):
            raise Unsafe('an idle-stop invocation is still active')

    def restore_timer(self):
        self.command('systemctl', 'start', IDLE_TIMER)

    def health(self):
        if self.connection is None:
            self.connection = http.client.HTTPConnection('127.0.0.1', 8000, timeout=5)
        self.connection.request('GET', '/api/health')
        response = self.connection.getresponse()
        data = response.read(1024 * 1024 + 1)
        if response.status != 200 or len(data) > 1024 * 1024 or self.connection.sock is None:
            raise Unsafe('persistent health connection was lost')
        return json.loads(data)

    def close_health(self):
        if self.connection is not None:
            self.connection.close()

    def remove_leftover_gates(self):
        """The REJECT rules of an earlier run that was killed (SIGKILL skips its cleanup): left in place, they keep
        refusing nginx's and the next deployment's new connections to the API."""
        for line in self.command('iptables', '-S', 'OUTPUT').stdout.splitlines():
            if line.startswith('-A OUTPUT ') and re.search(r'--comment "?studio-legacy-[0-9a-f]{32}"?( |$)', line):
                self.command('iptables', '-D', *shlex.split(line)[1:])

    def gate(self, action):
        self.command('iptables', action, 'OUTPUT', '-p', 'tcp', '-d', '127.0.0.1', '--dport', '8000',
                     '-m', 'conntrack', '--ctstate', 'NEW', '-m', 'comment', '--comment', self.tag,
                     '-j', 'REJECT', '--reject-with', 'tcp-reset')

    def close_ingress(self):
        self.gate('-I')
        self.gate_installed = True
        # Prove the installed rule actually rejects the route, rather than trusting a successful iptables command.
        try:
            connection = socket.create_connection(('127.0.0.1', 8000), timeout=2)
        except ConnectionRefusedError:
            return
        except OSError:
            raise Unsafe('new API connection refusal could not be verified') from None
        connection.close()
        raise Unsafe('new API connections are still being accepted')

    def open_ingress(self):
        if self.gate_installed:
            self.gate('-D')
            self.gate_installed = False

    def socket_busy(self):
        health_port = self.connection.sock.getsockname()[1]
        return any(foreign_api_sockets(Path(path).read_text(), health_port)
                   for path in ('/proc/net/tcp', '/proc/net/tcp6'))

    def worker_busy(self):
        rows = self.command('docker', 'top', SERVICE, '-eo', 'pid,comm').stdout.splitlines()[1:]
        processes = [(int(row.split()[0]), row.split()[1]) for row in rows]
        python = [pid for pid, comm in processes if comm.startswith('python')]
        if len(python) != 2 or any(comm != 'nginx' and not comm.startswith('python') for _, comm in processes):
            return True
        allowed = set(python) | {os.getpid()}
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                comm = (path / 'comm').read_text().strip().lower()
            except FileNotFoundError:
                continue
            if (comm.startswith(('python', 'blender', 'uvicorn')) and int(path.name) not in allowed):
                return True
        return False

    def same_runtime(self, metadata):
        return self.metadata()['container_id'] == metadata['container_id']

    def term(self, metadata):
        # Docker's normal stop command has a forced-kill timeout. Disable restart then send TERM only, and observe
        # actual exit. The reviewed entrypoint has a child kill fallback, so this is permitted only after socket,
        # middleware/background, runner and CLI proof has remained idle through the final check.
        self.command('docker', 'update', '--restart=no', metadata['container_id'])
        self.command('docker', 'kill', '--signal=TERM', metadata['container_id'])

    def running(self, metadata):
        result = self.command('docker', 'inspect', '-f', '{{.State.Running}}', metadata['container_id'])
        if result.stdout.strip() not in ('true', 'false'):
            raise Unsafe('container termination cannot be verified')
        return result.stdout.strip() == 'true'

    def receipt(self, value):
        temporary = RECEIPT.with_suffix('.json.new')
        with temporary.open('w') as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(RECEIPT)


def bootstrap(host, *, timeout=420, quiet_seconds=10):
    if quiet_seconds < 10 or timeout < quiet_seconds:
        raise Unsafe('at least ten seconds of verified idle is required')
    metadata = host.metadata()
    proof = host.proof()
    timer_active = host.timer_active()
    signalled = stopped = False
    receipt = {**metadata, **proof, 'idle_timer_was_active': timer_active, 'gate_tag': host.tag,
               'operator_cli_suspended': True, 'quiet_seconds': quiet_seconds}
    try:
        host.receipt({**receipt, 'status': 'preparing'})
        host.stop_timer()
        _, api_pid = checked_activity(host.health())
        host.close_ingress()
        host.receipt({**receipt, 'status': 'ingress_closed'})
        deadline, quiet_since = host.clock() + timeout, None
        while True:
            busy, pid = checked_activity(host.health())
            if pid != api_pid or not host.same_runtime(metadata):
                raise Unsafe('runtime changed during maintenance')
            idle = busy == 0 and not host.socket_busy() and not host.worker_busy()
            moment = host.clock()
            quiet_since = (quiet_since if quiet_since is not None else moment) if idle else None
            if quiet_since is not None and moment - quiet_since >= quiet_seconds:
                # Runner proof may drift while admitted work finishes; validate again immediately before TERM.
                proof = host.proof()
                if checked_activity(host.health()) != (0, api_pid) or host.socket_busy() or host.worker_busy():
                    quiet_since = None
                    continue
                host.close_health()
                signalled = True
                host.receipt({**receipt, 'status': 'sending_term'})
                host.term(metadata)
                break
            if moment >= deadline:
                raise Unsafe('existing work or connections did not finish; runtime was left running')
            host.sleep(1)
        exit_deadline = host.clock() + 60
        while host.running(metadata):
            if host.clock() >= exit_deadline:
                raise Unsafe('TERM did not finish; no KILL was sent. Inspect this existing runtime before retrying')
            host.sleep(1)
        stopped = True
        value = {**receipt, **proof, 'status': 'stopped',
                 'stopped_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        host.receipt(value)
        return value
    finally:
        host.close_health()
        host.open_ingress()
        if timer_active and not signalled:
            host.restore_timer()
        if not stopped:
            host.receipt({**receipt, 'status': 'termination_uncertain' if signalled else 'restored',
                          'gate_removed': True})
        # After TERM the state is either stopped or uncertain. Keep idle-stop disabled until the next deploy or
        # explicit recovery; turning it on could power off a runtime whose exit has not yet been verified.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-release', required=True)
    parser.add_argument('--timeout', type=int, default=420)
    args = parser.parse_args()
    if args.expected_release != LEGACY_RELEASE or os.geteuid() != 0:
        raise Unsafe('only root may maintain the explicitly pinned reviewed legacy release')
    import fcntl
    with ExitStack() as stack:
        for name in ('prepare', 'deploy'):
            stream = stack.enter_context(open(f'/var/lock/asset-studio-{name}.lock', 'a'))
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, lambda *_: (_ for _ in ()).throw(Unsafe('maintenance interrupted')))
        host = Host()
        host.remove_leftover_gates()
        print(json.dumps(bootstrap(host, timeout=args.timeout)))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # This tool reads identifiers and counter source only; neither provider values nor exception stderr is printed.
        print(str(exc) if isinstance(exc, Unsafe) else 'maintenance failed; inspect local state before retrying', file=sys.stderr)
        sys.exit(1)
