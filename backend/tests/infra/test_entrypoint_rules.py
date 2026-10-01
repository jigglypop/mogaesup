import importlib.util
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[2] / 'infra' / 'entrypoint.py'
KEY = 'Kq3VzX9mTt7RbN2wLp4HyC8sDf6JgA1uEoWi5xMhY0cB'
PROXY = ['  proxy_pass http://127.0.0.1:8000;', '  proxy_set_header X-User-Id 1;', '  proxy_set_header Host $host;',
         '  proxy_read_timeout 65s;', '  proxy_buffering off;']
# What the container wrote to /etc/nginx/studio-public.conf before the gateway key existed.
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


def test_the_public_api_is_unchanged_without_a_key(entrypoint):
    assert entrypoint.public_rules(True) == OPEN
    assert entrypoint.public_rules(True, '') == OPEN


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


def test_the_rules_file_is_written_and_a_missing_key_is_warned_about_once(entrypoint, tmp_path, capsys):
    target = tmp_path / 'studio-public.conf'
    entrypoint.write_public_rules(target, True, '')
    assert target.read_text(encoding='utf-8') == '\n'.join(OPEN) + '\n'
    warning = capsys.readouterr().err
    assert warning.startswith('warning: STUDIO_GATEWAY_KEY is not set') and len(warning.splitlines()) == 1


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
