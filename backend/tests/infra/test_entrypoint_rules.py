import importlib.util
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[2] / 'infra' / 'entrypoint.py'
KEY = 'Kq3VzX9mTt7RbN2wLp4HyC8sDf6JgA1uEoWi5xMhY0cB'
PROXY = ['  proxy_pass http://127.0.0.1:8000;', '  proxy_set_header X-User-Id 1;', '  proxy_set_header Host 127.0.0.1;',
         '  proxy_set_header Forwarded "";', '  proxy_set_header X-Forwarded-For "";', '  proxy_set_header X-Real-IP "";',
         '  proxy_read_timeout 65s;', '  proxy_buffering off;']
# What the container writes to /etc/nginx/studio-public.conf around the gateway check.
OPEN = ['location /api/ {', *PROXY, '}',
        'location ~ ^/api/(avatar-factory/base-bodies/glb-assets|studio/glb-assets/upload)$ {',
        '  client_max_body_size 256m;', *PROXY, '}',
        'location = /health { return 404; }']
CLOSED = ['location /api/ { return 404; }', 'location = /health { return 404; }']
GATE = f'  if ($http_x_gateway_key != "{KEY}") {{ return 403; }}'


@pytest.fixture(scope='module')
def entrypoint():
    spec = importlib.util.spec_from_file_location('studio_entrypoint', ENTRYPOINT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # `main` is guarded: importing reads no secrets and starts nothing
    return module


def test_an_open_studio_without_a_gateway_key_is_refused(entrypoint):
    for key in (None, ''):
        with pytest.raises(SystemExit, match='STUDIO_GATEWAY_KEY'):
            entrypoint.public_rules(True, key)


def test_a_gateway_key_gates_both_api_locations_and_nothing_else(entrypoint):
    rules = entrypoint.public_rules(True, KEY)
    assert rules.count(GATE) == 2
    assert [line for line in rules if line != GATE] == OPEN
    # The check sits before the proxy directives of each location.
    for opening in ('location /api/ {', 'location ~ ^/api/(avatar-factory/base-bodies/glb-assets|studio/glb-assets/upload)$ {'):
        start = rules.index(opening)
        assert rules.index(GATE, start) < rules.index('  proxy_pass http://127.0.0.1:8000;', start)
    assert 'location = /health { return 404; }' in rules


def test_every_proxied_location_carries_the_check(entrypoint):
    blocks, current = [], None
    for line in entrypoint.public_rules(True, KEY):
        if line.startswith('location') and line.endswith('{'):
            current = []
            blocks.append(current)
        if current is not None:
            current.append(line)
    proxied = [block for block in blocks if '  proxy_pass http://127.0.0.1:8000;' in block]
    assert len(proxied) == 2 and all(GATE in block for block in proxied)


@pytest.mark.parametrize('key', [
    'short-key',
    KEY[:15],
    KEY + ' ',
    KEY + '\n',
    'a' * 16 + '"',
    'a' * 16 + '$host',
    'a' * 16 + '\\',
    'a' * 16 + '";}location / {proxy_pass http://evil;}#',
    'a' * 16 + '\nlocation / { return 200; }',
    'a' * 8 + ' ' + 'b' * 8,
    '키' * 16,
])
def test_a_key_that_could_inject_nginx_config_stops_the_start(entrypoint, key):
    with pytest.raises(SystemExit) as stopped:
        entrypoint.public_rules(True, key)
    assert key.strip() not in str(stopped.value)


@pytest.mark.parametrize('key', ['a' * 16, 'A.b_c~d-' * 4, KEY])
def test_keys_made_of_the_allowed_characters_are_accepted(entrypoint, key):
    assert entrypoint.public_rules(True, key)[1].startswith('  if ($http_x_gateway_key != "')


def test_a_closed_studio_stays_closed_whatever_the_key(entrypoint):
    assert entrypoint.public_rules(False) == CLOSED
    assert entrypoint.public_rules(False, KEY) == CLOSED


def test_the_key_is_an_allowed_secret(entrypoint):
    assert 'STUDIO_GATEWAY_KEY' in entrypoint.allowed


def test_a_missing_gateway_key_writes_no_open_rules(entrypoint, tmp_path, capsys):
    target = tmp_path / 'studio-public.conf'
    with pytest.raises(SystemExit, match='STUDIO_GATEWAY_KEY'):
        entrypoint.write_public_rules(target, True, '')
    assert not target.exists()
    assert capsys.readouterr().err == ''


def test_a_given_key_is_written_but_never_printed(entrypoint, tmp_path, capsys):
    target = tmp_path / 'studio-public.conf'
    entrypoint.write_public_rules(target, True, KEY)
    assert target.read_text(encoding='utf-8').count(KEY) == 2
    output = capsys.readouterr()
    assert output.out == '' and output.err == ''


def test_a_closed_studio_needs_no_warning_and_a_bad_key_writes_nothing(entrypoint, tmp_path, capsys):
    closed = tmp_path / 'closed.conf'
    entrypoint.write_public_rules(closed, False, '')
    assert closed.read_text(encoding='utf-8') == '\n'.join(CLOSED) + '\n'
    assert capsys.readouterr().err == ''
    refused = tmp_path / 'refused.conf'
    with pytest.raises(SystemExit):
        entrypoint.write_public_rules(refused, True, 'a' * 16 + '"')
    assert not refused.exists()


PREVIOUS = 'Zz9YyXx8WwVv7UuTt6SsRr5QqPp4OoNn3MmLl2KkJj1I'


def test_a_rotation_accepts_the_current_and_the_previous_key_and_nothing_else(entrypoint):
    rules = entrypoint.public_rules(True, KEY, PREVIOUS)
    gate = ['  set $studio_gateway 0;', f'  if ($http_x_gateway_key = "{KEY}") {{ set $studio_gateway 1; }}',
            f'  if ($http_x_gateway_key = "{PREVIOUS}") {{ set $studio_gateway 1; }}',
            '  if ($studio_gateway = 0) { return 403; }']
    for opening in ('location /api/ {', 'location ~ ^/api/(avatar-factory/base-bodies/glb-assets|studio/glb-assets/upload)$ {'):
        start = rules.index(opening)
        proxy = rules.index('  proxy_pass http://127.0.0.1:8000;', start)
        assert [line for line in rules[start:proxy] if line in gate] == gate
    assert [line for line in rules if line not in gate] == OPEN
    assert GATE not in rules


@pytest.mark.parametrize('previous', [KEY, 'short', 'a' * 16 + '"', 'a' * 16 + '$host'])
def test_a_previous_key_that_is_the_current_one_or_invalid_stops_the_start(entrypoint, previous):
    with pytest.raises(SystemExit, match='STUDIO_GATEWAY_KEY_PREVIOUS') as stopped:
        entrypoint.public_rules(True, KEY, previous)
    assert previous not in str(stopped.value)


def test_a_closed_studio_ignores_the_previous_key(entrypoint):
    assert entrypoint.public_rules(False, KEY, PREVIOUS) == CLOSED


def test_the_previous_key_is_an_allowed_secret_and_never_printed(entrypoint, tmp_path, capsys):
    assert 'STUDIO_GATEWAY_KEY_PREVIOUS' in entrypoint.allowed
    target = tmp_path / 'studio-public.conf'
    entrypoint.write_public_rules(target, True, KEY, PREVIOUS)
    text = target.read_text(encoding='utf-8')
    assert text.count(KEY) == 2 and text.count(PREVIOUS) == 2
    assert capsys.readouterr() == ('', '')


def test_the_release_stamp_names_the_git_commit_only_when_it_is_one(entrypoint, tmp_path):
    release = tmp_path / 'release.json'
    sha = 'b' * 64
    assert entrypoint.release_stamp(sha, release) == {'release_sha': sha}
    release.write_text('{"git_commit": "' + 'c' * 40 + '"}', encoding='utf-8')
    assert entrypoint.release_stamp(sha, release) == {'release_sha': sha, 'git_commit': 'c' * 40}
    for value in ('null', '"main"', '"' + 'C' * 40 + '"', '[]'):
        release.write_text('{"git_commit": ' + value + '}', encoding='utf-8')
        assert entrypoint.release_stamp(sha, release) == {'release_sha': sha}
    release.write_text('not json', encoding='utf-8')
    assert entrypoint.release_stamp(sha, release) == {'release_sha': sha}


def test_nginx_answers_only_requests_that_name_the_loopback_on_the_ssm_port():
    text = ENTRYPOINT.with_name('nginx.conf').read_text(encoding='utf-8')
    servers = text.split('  server {')[1:]
    default, studio = servers[0], servers[1]
    assert 'listen 127.0.0.1:8080 default_server;' in default and 'return 444;' in default and 'access_log off;' in default
    assert 'listen 127.0.0.1:8080;' in studio and 'server_name 127.0.0.1 localhost;' in studio
    assert studio.count('proxy_set_header Host 127.0.0.1;') == 2 and '$host' not in studio
    assert 'Origin' not in studio.replace('foreign Origin', '')
