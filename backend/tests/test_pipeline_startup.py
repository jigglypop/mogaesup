"""What happens around the server's start: automatic resume (opt-in, never from a GET), logging, identity, and the
command-line tools that must not depend on the directory they are started in.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import threading
import types

import httpx
import pytest

from src import character_cli, editor_cli
from src.runtime_identity import runtime_identity
from src.services import avatar_auto_resume as auto
from src.services import character_audit
from src.services.asset_editor import _write_json
from src.services.avatar_factory import AvatarFactory
from src.services.character_pipeline import now, read_json

JOB = 'c' * 24
EARLIER_EXECUTOR = {'pid': os.getpid(), 'created_at': 1.0}  # this pid, but not the process that started the job


# --- automatic resume -------------------------------------------------------------------------------------------------

@pytest.mark.parametrize(('value', 'opted_in'), [
    (None, False), ('', False), ('0', False), ('no', False), ('off', False), ('2', False),
    ('1', True), ('true', True), ('TRUE', True), ('Yes', True), (' 1 ', True)])
def test_automatic_resume_is_opt_in(monkeypatch, value, opted_in):
    if value is None:
        monkeypatch.delenv('ASSET_AUTO_RESUME', raising=False)
    else:
        monkeypatch.setenv('ASSET_AUTO_RESUME', value)
    assert auto.opted_in() is opted_in


def test_automatic_resume_is_on_only_when_opted_in_and_never_under_pytest(monkeypatch):
    monkeypatch.setenv('ASSET_AUTO_RESUME', '1')
    assert auto.opted_in() and not auto.enabled()
    with monkeypatch.context() as outside_pytest:
        outside_pytest.delitem(sys.modules, 'pytest')
        assert auto.enabled()
        outside_pytest.delenv('ASSET_AUTO_RESUME')
        assert not auto.enabled()


def paused_job(factory, **fields):
    directory = factory.root / '1' / JOB
    directory.mkdir(parents=True)
    # Its last activity is recent: the scan at startup only continues stops of the last few hours.
    _write_json(directory / 'job.json', {
        'id': JOB, 'status': 'pipeline_running', 'executor': 'earlier-instance', 'executor_process': EARLIER_EXECUTOR,
        'production_mode': 'character_parts', 'resume_stage': 'models', 'created_at': now(), 'updated_at': now(), **fields})
    return directory


def test_a_get_of_a_job_whose_executor_died_only_records_the_stop(tmp_path, monkeypatch):
    started = []
    monkeypatch.setattr(auto, 'schedule', lambda *args: started.append(args))
    monkeypatch.setattr(auto, 'enabled', lambda: True)  # even for a server that opted in
    factory = AvatarFactory(tmp_path)
    directory = paused_job(factory, updated_at='2026-09-30T01:00:00+00:00')
    public = factory.get(1, JOB)
    saved = read_json(directory / 'job.json')
    assert public['status'] == saved['status'] == 'pipeline_paused' and saved['error'] == '서버 재시작으로 중단됨'
    assert saved['interrupted']['stage'] == 'models' and saved['interrupted']['at'] == '2026-09-30T01:00:00+00:00'
    assert started == [] and not [thread for thread in threading.enumerate() if thread.name.startswith('auto-resume')]


class InlineThread:
    """A thread that runs its target when started, so the startup scan can be observed."""

    def __init__(self, target=None, name=None, daemon=None):
        self.target = target

    def start(self):
        self.target()


def test_the_startup_scan_schedules_a_stopped_job_only_when_enabled(tmp_path, monkeypatch):
    scheduled = []
    monkeypatch.setattr(auto, 'schedule', lambda factory, owner, job_id: scheduled.append((owner, job_id)))
    monkeypatch.setattr(auto, 'threading', types.SimpleNamespace(Thread=InlineThread, Lock=threading.Lock))
    monkeypatch.setattr(auto, 'time', types.SimpleNamespace(sleep=lambda seconds: None))
    factory = AvatarFactory(tmp_path)
    paused_job(factory)
    monkeypatch.setattr(auto, 'enabled', lambda: False)
    auto.start(factory)
    assert scheduled == [] and read_json(factory.root / '1' / JOB / 'job.json')['status'] == 'pipeline_running'
    monkeypatch.setattr(auto, 'enabled', lambda: True)
    auto.start(factory)
    assert scheduled == [(1, JOB)]


def test_scheduling_does_nothing_for_a_server_that_did_not_opt_in(monkeypatch):
    monkeypatch.delenv('ASSET_AUTO_RESUME', raising=False)

    def no_thread(*args, **kwargs):
        pytest.fail('a server that did not opt in must not resume anything')
    monkeypatch.setattr(auto, 'threading', types.SimpleNamespace(Thread=no_thread, Lock=threading.Lock))
    auto.schedule(object(), 1, JOB)


def test_the_environment_template_leaves_automatic_resume_off():
    template = (Path(__file__).resolve().parents[1] / '.env.example').read_text(encoding='utf-8')
    assert re.search(r'^ASSET_AUTO_RESUME=0$', template, re.MULTILINE)


# --- logging and identity -----------------------------------------------------------------------------------------------

def test_the_server_module_configures_logging_when_uvicorn_imports_it(monkeypatch):
    import src
    from src.api import server
    configured = []
    monkeypatch.setattr(src, 'configure_logging', lambda: configured.append(True))
    # A second copy of the module, as uvicorn's import would make it; the app other tests use stays as it is.
    spec = importlib.util.spec_from_file_location('server_logging_probe', server.__file__)
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    assert configured == [True]


def test_the_runtime_identity_follows_the_record_database(monkeypatch):
    monkeypatch.setenv('CHARACTER_DATABASE_URL', 'postgresql://studio:private@127.0.0.1:5432/one')
    first = runtime_identity()
    assert runtime_identity()['revision'] == first['revision']
    monkeypatch.setenv('CHARACTER_DATABASE_URL', 'postgresql://studio:private@127.0.0.1:5432/two')
    assert runtime_identity()['revision'] != first['revision']
    assert 'private' not in json.dumps(runtime_identity())


# --- command-line tools -------------------------------------------------------------------------------------------------

def test_character_cli_defaults_follow_a_data_root_that_only_the_env_file_sets(tmp_path, monkeypatch, capsys):
    run = tmp_path / 'env-file-root' / 'characters' / 'A'
    run.mkdir(parents=True)
    (run / 'character.json').write_text(json.dumps({'stage': 'generation', 'status': 'PENDING', 'task_id': 'task-1'}))
    monkeypatch.setattr(character_cli, 'load_dotenv', lambda: monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path / 'env-file-root')))
    client_type = httpx.Client
    monkeypatch.setattr(character_cli.httpx, 'Client', lambda **kwargs: client_type(
        **kwargs, transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'status': 'SUCCEEDED', 'progress': 100}))))
    monkeypatch.setenv('MESHY_API_KEY', 'fixture-key')
    monkeypatch.setattr(sys, 'argv', ['character', 'status'])
    character_cli.main()
    assert json.loads(capsys.readouterr().out)['status'] == 'SUCCEEDED'
    assert read_json(run / 'character.json')['status'] == 'SUCCEEDED'


def test_the_editor_cli_keeps_its_projects_under_the_data_root_whatever_the_working_directory(tmp_path, monkeypatch, capsys):
    head = tmp_path / 'data' / 'editor' / 'project' / 'head.json'
    head.parent.mkdir(parents=True)
    head.write_text(json.dumps({'revision': 3}))
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path / 'data'))
    monkeypatch.setattr(sys, 'argv', ['asset-editor', 'inspect', 'project'])
    editor_cli.main()
    assert json.loads(capsys.readouterr().out) == {'revision': 3}


def test_the_audit_cli_reads_its_manifest_relative_to_the_data_root_whatever_the_working_directory(tmp_path, monkeypatch, capsys):
    root = tmp_path / 'data'
    (root / 'image').mkdir(parents=True)
    (root / 'image' / 'A.png').write_bytes(b'source')
    manifest = root / 'characters' / 'batch.json'
    manifest.parent.mkdir()
    manifest.write_text(json.dumps({'version': 1, 'characters': [
        {'id': 'A', 'image': 'image/A.png', 'run': 'characters/A', 'height_meters': 1.7, 'required_parts': ['body']}]}))
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    monkeypatch.setenv('ASSET_DATA_ROOT', str(root))
    monkeypatch.setattr(sys, 'argv', ['audit', str(manifest), '--json'])
    character_audit.main()
    [item] = json.loads(capsys.readouterr().out)
    assert item['id'] == 'A' and item['next_action'] != 'provide_source_image'


def test_the_blender_the_editor_cli_starts_gets_no_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-private')
    monkeypatch.setenv('CHARACTER_DATABASE_URL', 'postgresql://studio:private@127.0.0.1:5432/records')
    monkeypatch.setenv('AVATAR_SETTING', 'kept')
    blender = tmp_path / 'blender.exe'
    blender.write_bytes(b'')
    launched = {}

    class Process:
        pid = 4321

        def poll(self):
            return None

    class Probe:
        checks = 0

        def __enter__(self):
            return self

        def __exit__(self, *error):
            return False

        def connect_ex(self, address):
            Probe.checks += 1
            return 1 if Probe.checks == 1 else 0  # the port is free, then Blender listens

    monkeypatch.setattr(editor_cli, 'importlib', types.SimpleNamespace(util=types.SimpleNamespace(
        find_spec=lambda name: types.SimpleNamespace(origin=str(tmp_path / 'blender_mcp' / '__init__.py')))))
    monkeypatch.setattr(editor_cli, 'socket', types.SimpleNamespace(socket=Probe))
    monkeypatch.setattr(editor_cli, 'time', types.SimpleNamespace(sleep=lambda seconds: None))
    monkeypatch.setattr(editor_cli.subprocess, 'Popen', lambda command, **kwargs: launched.update(kwargs) or Process())
    result = editor_cli.start_blender(blender, tmp_path / 'editor', 9876)
    assert result['pid'] == 4321
    environment = launched['env']
    assert 'OPENAI_API_KEY' not in environment and 'CHARACTER_DATABASE_URL' not in environment
    assert environment['AVATAR_SETTING'] == 'kept' and environment['DISABLE_TELEMETRY'] == 'true'
