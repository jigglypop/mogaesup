import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


spec = importlib.util.spec_from_file_location('legacy_bootstrap', Path(__file__).parents[2] / 'infra/bootstrap-legacy-runtime.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


def health(paid=0, tasks=0):
    return {'status': 'healthy', 'activity': {'paid_requests': paid, 'running_tasks': tasks},
            'runtime': {'pid': 7}, 'connections': {'database': {'configured': True, 'ok': True}}}


class FakeHost:
    tag = 'test-gate'

    def __init__(self, *, health_values=None, socket_times=(), worker_times=(), termination=True):
        self.now = 0
        self.events = []
        self.receipts = []
        self.health_values = list(health_values or [])
        self.socket_times = set(socket_times)
        self.worker_times = set(worker_times)
        self.termination = termination
        self.stopped = False

    def metadata(self):
        return {'container_id': 'old', 'release_sha': bootstrap.LEGACY_RELEASE, 'restart_policy': 'unless-stopped'}

    def proof(self):
        return {'activity_sha256': bootstrap.LEGACY_ACTIVITY, 'runner_count': 5}

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds

    def timer_active(self):
        return True

    def stop_timer(self):
        self.events.append('stop_timer')

    def restore_timer(self):
        self.events.append('restore_timer')

    def health(self):
        return self.health_values.pop(0) if self.health_values else health()

    def close_health(self):
        self.events.append('close_health')

    def close_ingress(self):
        self.events.append('close_ingress')

    def open_ingress(self):
        self.events.append('open_ingress')

    def socket_busy(self):
        return self.now in self.socket_times

    def worker_busy(self):
        return self.now in self.worker_times

    def same_runtime(self, _metadata):
        return True

    def term(self, _metadata):
        self.events.append(('TERM', self.now))
        self.stopped = self.termination

    def running(self, _metadata):
        return not self.stopped

    def receipt(self, value):
        self.receipts.append(value)


def test_new_work_after_gate_resets_the_quiet_interval_before_any_signal():
    host = FakeHost(health_values=[health(), health(), health(tasks=1), health(tasks=1), health()])
    value = bootstrap.bootstrap(host, timeout=30)
    assert value['status'] == 'stopped'
    assert ('TERM', 13) in host.events
    assert host.events.index('close_ingress') < host.events.index(('TERM', 13)) < host.events.index('open_ingress')
    assert 'restore_timer' not in host.events  # The immediately following normal deploy installs the safe timer.


def test_half_open_sockets_and_cli_workers_each_restart_the_idle_proof():
    host = FakeHost(socket_times={9}, worker_times={18})
    bootstrap.bootstrap(host, timeout=40)
    assert ('TERM', 29) in host.events


@pytest.mark.parametrize('counter', [None, -1, True, '0'])
def test_invalid_legacy_health_reopens_without_signalling(counter):
    host = FakeHost(health_values=[health(), health(tasks=counter)])
    with pytest.raises(bootstrap.Unsafe, match='cannot be verified'):
        bootstrap.bootstrap(host)
    assert not any(isinstance(event, tuple) for event in host.events)
    assert host.events[-3:] == ['close_health', 'open_ingress', 'restore_timer']
    assert host.receipts[-1]['status'] == 'restored'


def test_work_timeout_and_interruption_preserve_the_runtime_and_restore_admission():
    host = FakeHost(health_values=[health()] + [health(tasks=1)] * 20)
    with pytest.raises(bootstrap.Unsafe, match='left running'):
        bootstrap.bootstrap(host, timeout=10)
    assert ('TERM', 10) not in host.events
    assert host.events[-1] == 'restore_timer'
    interrupted = FakeHost()
    interrupted.sleep = lambda _: (_ for _ in ()).throw(bootstrap.Unsafe('interrupted'))
    with pytest.raises(bootstrap.Unsafe, match='interrupted'):
        bootstrap.bootstrap(interrupted)
    assert 'open_ingress' in interrupted.events and 'restore_timer' in interrupted.events
    assert not any(isinstance(event, tuple) for event in interrupted.events)


def test_slow_termination_is_observed_without_kill_or_idle_shutdown():
    host = FakeHost(termination=False)
    with pytest.raises(bootstrap.Unsafe, match='no KILL'):
        bootstrap.bootstrap(host)
    assert [event for event in host.events if isinstance(event, tuple)] == [('TERM', 10)]
    assert 'open_ingress' in host.events and 'restore_timer' not in host.events
    assert host.receipts[-1]['status'] == 'termination_uncertain'


def test_network_gate_is_checked_using_a_real_new_connection_and_cleanup_is_owned(monkeypatch):
    host = bootstrap.Host()
    calls = []
    host.command = lambda *args, **_kwargs: calls.append(args) or SimpleNamespace(returncode=0)
    monkeypatch.setattr(bootstrap.socket, 'create_connection', lambda *_args, **_kwargs: (_ for _ in ()).throw(ConnectionRefusedError()))
    host.close_ingress()
    host.open_ingress()
    assert [call[1] for call in calls] == ['-I', '-D']
    assert calls[0][2:] == calls[1][2:]
    assert '--ctstate' in calls[0] and 'NEW' in calls[0]
    assert not host.gate_installed
    monkeypatch.setattr(bootstrap.socket, 'create_connection', lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None))
    with pytest.raises(bootstrap.Unsafe, match='still being accepted'):
        host.close_ingress()
    assert host.gate_installed  # Orchestrator finally removes the exact installed rule even on failed proof.


@pytest.mark.parametrize('state', ['01', '02', '03', '04', '05', '08', '09', '0B'])
def test_every_nonterminal_api_socket_counts_not_only_established(state):
    lines = f'header\n 0: 0100007F:1F40 0100007F:C350 {state} rest\n'
    assert bootstrap.foreign_api_sockets(lines, 50001)
    assert not bootstrap.foreign_api_sockets(lines, 50000)


def test_time_wait_and_listener_sockets_do_not_keep_an_idle_server_busy():
    for state in ['06', '07', '0A']:
        assert not bootstrap.foreign_api_sockets(f'header\n0: 0100007F:1F40 0100007F:C350 {state} rest\n', 50001)


def test_another_loopback_address_with_the_same_port_is_not_the_health_connection():
    assert bootstrap.foreign_api_sockets('header\n0: 0100007F:1F40 0200007F:C350 01 rest\n', 50000)
    assert bootstrap.foreign_api_sockets('header\n0: 00000000000000000000000001000000:1F40 '
                                         '00000000000000000000000001000000:C350 01 rest\n', 50000)


def test_term_command_has_no_force_kill_timeout():
    host = bootstrap.Host()
    calls = []
    host.command = lambda *args: calls.append(args)
    host.term({'container_id': 'old'})
    assert calls == [('docker', 'update', '--restart=no', 'old'), ('docker', 'kill', '--signal=TERM', 'old')]


def test_rules_a_killed_run_left_are_removed_and_no_others(monkeypatch):
    host = bootstrap.Host()
    calls = []
    listed = ('-P OUTPUT ACCEPT\n'
              '-A OUTPUT -d 127.0.0.1/32 -p tcp -m tcp --dport 8000 -m conntrack --ctstate NEW -m comment --comment '
              'studio-legacy-' + 'a' * 32 + ' -j REJECT --reject-with tcp-reset\n'
              '-A OUTPUT -d 10.0.0.0/8 -m comment --comment "someone else" -j ACCEPT\n')

    def command(*args, check=True):
        calls.append(args)
        return SimpleNamespace(stdout=listed if args[1] == '-S' else '', returncode=0)
    monkeypatch.setattr(host, 'command', command)
    host.remove_leftover_gates()
    assert calls[1][:3] == ('iptables', '-D', 'OUTPUT') and '-j' in calls[1] and len(calls) == 2
    assert 'studio-legacy-' + 'a' * 32 in calls[1]
