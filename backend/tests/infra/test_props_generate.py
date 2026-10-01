import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

GENERATE = Path(__file__).resolve().parents[3] / 'scripts' / 'props' / 'generate.py'
CHILD_PID = 4242424


@pytest.fixture(scope='module')
def generate():
    spec = importlib.util.spec_from_file_location('props_generate', GENERATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # `main` is guarded: importing starts nothing
    return module


@pytest.fixture
def health_server():
    """A loopback server that answers every GET with the given /health body: it stands for whatever else listens there."""
    servers = []

    def serve(body):
        payload = json.dumps(body).encode()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return server.server_address[1]
    yield serve
    for server in servers:
        server.shutdown()
        server.server_close()


class FakeProcess:
    """The uvicorn child of start_api: alive until `exit_code` is set."""
    pid = CHILD_PID
    exit_code = None

    def __init__(self, *args, **kwargs):
        self.terminated = False

    def poll(self):
        return self.exit_code

    def terminate(self):
        self.terminated = True


@pytest.fixture
def start(generate, monkeypatch, tmp_path):
    """start_api() with the port it picks and the process it starts replaced; returns what it started."""
    started = []

    def popen(*args, **kwargs):
        started.append(FakeProcess(*args, **kwargs))
        return started[-1]
    monkeypatch.setattr(generate, 'HERE', tmp_path)
    monkeypatch.setattr(generate, 'subprocess', SimpleNamespace(Popen=popen, STDOUT=subprocess.STDOUT))
    return started


def test_free_port_is_one_nothing_listens_on(generate):
    port = generate.free_port()
    assert 1024 <= port <= 65535
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', port))
    with socket.socket() as taken:
        taken.bind(('127.0.0.1', 0))
        taken.listen()
        assert generate.free_port() != taken.getsockname()[1]


def test_only_a_health_with_our_pid_is_ours(generate):
    assert generate.is_own_health({'status': 'healthy', 'runtime': {'pid': 7}}, {7, 8})
    assert not generate.is_own_health({'status': 'healthy', 'runtime': {'pid': 9}}, {7, 8})
    for answer in (None, [], 'healthy', {}, {'runtime': None}, {'runtime': []}, {'runtime': {}}, {'runtime': {'pid': '7'}},
                   {'runtime': {'pid': None}}, {'runtime': {'pid': True}}, {'status': 'healthy', 'connections': {}}):
        assert not generate.is_own_health(answer, {7, 1})


def test_the_process_family_has_the_children_a_launcher_starts(generate):
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    try:
        assert child.pid in generate.process_family(child.pid)
    finally:
        child.kill()
        child.wait()
    assert generate.process_family(2 ** 22 + 4242) == {2 ** 22 + 4242}


def test_a_server_already_on_the_port_is_not_mistaken_for_the_started_one(generate, start, health_server, monkeypatch):
    # Another character server (npm run dev:character) answers 200 with a pid that is not the child's.
    port = health_server({'status': 'healthy', 'runtime': {'workspace': 'w', 'revision': 'r', 'pid': os.getpid()}})
    monkeypatch.setattr(generate, 'free_port', lambda: port)
    with pytest.raises(SystemExit, match='did not answer its own /health'):
        generate.start_api(timeout=1.2)
    assert start[0].terminated


def test_the_started_server_is_taken_once_it_reports_its_own_pid(generate, start, health_server, monkeypatch):
    port = health_server({'status': 'healthy', 'runtime': {'pid': CHILD_PID}})
    monkeypatch.setattr(generate, 'free_port', lambda: port)
    process, base = generate.start_api(timeout=5)
    assert process is start[0] and base == f'http://127.0.0.1:{port}' and not process.terminated


def test_the_port_given_to_uvicorn_is_the_one_the_client_uses(generate, start, health_server, monkeypatch):
    port = health_server({'runtime': {'pid': CHILD_PID}})
    monkeypatch.setattr(generate, 'free_port', lambda: port)
    commands = []
    original = generate.subprocess.Popen

    def popen(command, **kwargs):
        commands.append((command, kwargs['env']))
        return original(command, **kwargs)
    monkeypatch.setattr(generate.subprocess, 'Popen', popen)
    _, base = generate.start_api(timeout=5)
    (command, env), = commands
    assert command[command.index('--port') + 1] == str(port) and base.endswith(f':{port}')
    assert command[command.index('--host') + 1] == '127.0.0.1'
    # The sandbox stays: its own storage prefix, no record database, nothing resumed.
    assert (env['ASSET_S3_PREFIX'], env['CHARACTER_DATABASE_URL'], env['ASSET_AUTO_RESUME']) == ('mogaesup-props', '', '0')


def test_a_child_that_exited_is_reported_before_any_answer_counts(generate, start, health_server, monkeypatch):
    # Even a server that reports the child's pid cannot make up for a child that is gone.
    port = health_server({'runtime': {'pid': CHILD_PID}})
    monkeypatch.setattr(generate, 'free_port', lambda: port)
    FakeProcess.exit_code = 1
    try:
        with pytest.raises(SystemExit, match='character API exited'):
            generate.start_api(timeout=5)
    finally:
        FakeProcess.exit_code = None
