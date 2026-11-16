"""frontend/scripts/deploy-aws.ps1, the web release, run by PowerShell against a fake aws and a local copy of it."""
import functools
import http.server
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / 'frontend' / 'scripts' / 'deploy-aws.ps1'
ACCOUNT = '123456789012'
COMMIT = '0123456789abcdef0123456789abcdef01234567'
# A build: the engine files the release requires, hashed bundles and their maps, and files without a content hash.
BUILD = ['index.html', 'share.jpg', '모개.png', 'assets/index-new.js', 'assets/index-new.js.map', 'backdrop/island.webp',
         'fonts/sans.woff2', 'gltf/man.glb', 'gltf/props/tree.glb', 'wasm/gaesup_core.wasm', 'wasm/gaesup_gi.wasm']
# What a release invalidates: the names without a content hash (URL-encoded) and the release.json it writes beside them.
RELEASED = sorted(['/backdrop/*', '/fonts/*', '/gltf/*', '/index.html', '/release.json', '/share.jpg', '/wasm/*',
                   '/' + quote('모개.png')])
# The bucket after earlier releases, with the server's catalog beside them.
BUCKET = ['index.html', 'release.json', 'share.jpg', 'old-banner.jpg', 'assets/index-new.js', 'assets/index-new.js.map',
          'assets/index-old.js', 'assets/index-old.js.map', 'gltf/man.glb', 'gltf/props/tree.glb',
          'gltf/trainer_red.glb', 'wasm/gaesup_core.wasm', 'wasm/gaesup_gi.wasm', 'models/' + 'a' * 64 + '.glb']
STALE = {'old-banner.jpg', 'assets/index-new.js.map', 'assets/index-old.js.map', 'gltf/trainer_red.glb'}
SERVER = {'Outputs': [{'OutputKey': 'VpcOriginId', 'OutputValue': 'vo-0123456789abcdef0'},
                      {'OutputKey': 'ApiPrivateDns', 'OutputValue': 'ip-10-0-0-1.ap-northeast-2.compute.internal'}]}

FAKE_AWS = r'''
import json, os, sys
args = sys.argv[1:]
with open(os.environ['FAKE_AWS_LOG'], 'a', encoding='utf-8') as log:
    log.write(json.dumps(args) + '\n')
with open(os.environ['FAKE_AWS_STATE'], encoding='utf-8') as file:
    state = json.load(file)
bucket = 's3://site-bucket/'
def option(name):
    return args[args.index(name) + 1]
if args[:2] == ['sts', 'get-caller-identity']:
    print(state['account'])
elif args[:2] == ['cloudformation', 'describe-stacks']:
    stack = state['stacks'].get(option('--stack-name'))
    if stack is None:
        sys.exit('An error occurred (ValidationError) when calling the DescribeStacks operation: Stack does not exist')
    print(json.dumps(stack['Outputs'] if option('--query') == 'Stacks[0].Outputs' else stack))
elif args[:2] == ['s3api', 'list-objects-v2']:
    print(json.dumps(state['keys']))
elif args[:2] == ['cloudfront', 'create-invalidation']:
    print(json.dumps({'Invalidation': {'Id': 'invalidation-1'}}))
elif args[:2] == ['s3', 'cp'] and args[2].startswith(bucket) and '--recursive' not in args:
    # A download from the bucket; '-' writes it to stdout.
    key = args[2][len(bucket):]
    if key not in state['keys']:
        sys.exit('fatal error: An error occurred (404) when calling the HeadObject operation: Not Found')
    body = (json.dumps(state['live']) if 'live' in state else state['release']) if key == 'release.json' else key
    if args[3] == '-':
        print(body)
    else:
        with open(args[3], 'w', encoding='utf-8') as file:
            file.write(body + '\n')
elif args[:2] == ['s3', 'cp'] and args[3] == bucket + 'release.json':
    with open(args[2], encoding='utf-8') as file:
        state['release'] = file.read()
    with open(os.environ['FAKE_AWS_STATE'], 'w', encoding='utf-8') as file:
        json.dump(state, file)
elif args[0] not in ('cloudformation', 's3', 'cloudfront'):
    sys.exit('unexpected aws call')
'''


@pytest.fixture(scope='module')
def pwsh():
    found = shutil.which('pwsh')
    if not found or os.name == 'nt':
        pytest.skip('needs PowerShell 7 (pwsh) on Linux or macOS')
    return found


@pytest.fixture
def site(tmp_path):
    """The project as the script finds it (frontend/scripts, frontend/dist), its build served at a local address."""
    root = tmp_path / 'frontend'
    (root / 'scripts').mkdir(parents=True)
    shutil.copy(SCRIPT, root / 'scripts' / SCRIPT.name)
    for name in BUILD:
        (root / 'dist' / name).parent.mkdir(parents=True, exist_ok=True)
        (root / 'dist' / name).write_text(f'{name}\n', encoding='utf-8')

    class Files(http.server.SimpleHTTPRequestHandler):
        extensions_map = {'.html': 'text/html', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary'}

        def log_message(self, *args):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Files, directory=str(root / 'dist')))
    threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()
    yield SimpleNamespace(root=root, url=f'http://127.0.0.1:{server.server_address[1]}')
    server.shutdown()
    server.server_close()


def deploy(pwsh, site, tmp_path, *flags, stacks=None, api=False, live=None):
    """Runs the release as the pipeline does, with `flags`, and returns its result with the aws calls it made."""
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir(exist_ok=True)
    (tmp_path / 'fake_aws.py').write_text(FAKE_AWS, encoding='utf-8')
    (bin_dir / 'aws').write_text('#!/bin/sh\nexec "$PYTHON_EXE" "$FAKE_AWS" "$@"\n', encoding='utf-8')
    (bin_dir / 'aws').chmod(0o755)
    # With an API origin the release checks /api/health, which the local copy of the site does not answer.
    web = {'StackStatus': 'UPDATE_COMPLETE',
           'Parameters': [{'ParameterKey': 'ApiVpcOriginId', 'ParameterValue': 'vo-0123456789abcdef0'}] if api else [],
           'Outputs': [{'OutputKey': 'BucketName', 'OutputValue': 'site-bucket'},
                       {'OutputKey': 'DistributionId', 'OutputValue': 'EDISTRIBUTION'},
                       {'OutputKey': 'SiteUrl', 'OutputValue': site.url}]}
    state = tmp_path / 'aws-state.json'
    # `live` is a release.json another release wrote after this one.
    state.write_text(json.dumps({'account': ACCOUNT, 'keys': BUCKET, 'release': json.dumps({'git_commit': 'f' * 40}),
                                 'stacks': {'mogaesup-web': web, **(stacks or {})},
                                 **({'live': live} if live else {})}))
    log = tmp_path / 'aws-calls.jsonl'
    log.unlink(missing_ok=True)
    # Windows PowerShell 5.1 stops on a failing aws's redirected stderr under 'Stop'. PowerShell 7 does not, but with
    # this preference it stops on the exit code, which stands in for that here.
    command = (f"$PSNativeCommandUseErrorActionPreference = $true; "
               f"& '{site.root / 'scripts' / SCRIPT.name}' -ExpectedAccount {ACCOUNT} {' '.join(flags)}")
    done = subprocess.run([pwsh, '-NoProfile', '-NonInteractive', '-Command', command], capture_output=True,
                          encoding='utf-8', errors='replace', timeout=180,
                          env={'PATH': os.pathsep.join([str(bin_dir), '/usr/bin', '/bin']), 'HOME': str(tmp_path),
                               'TMPDIR': str(tmp_path), 'NO_COLOR': '1', 'POWERSHELL_TELEMETRY_OPTOUT': '1',
                               'POWERSHELL_UPDATECHECK': 'Off', 'GITHUB_ACTIONS': 'true', 'GITHUB_SHA': COMMIT,
                               'PYTHON_EXE': sys.executable, 'FAKE_AWS': str(tmp_path / 'fake_aws.py'),
                               'FAKE_AWS_LOG': str(log), 'FAKE_AWS_STATE': str(state)})
    calls = [json.loads(line) for line in log.read_text(encoding='utf-8').splitlines()] if log.exists() else []
    return SimpleNamespace(code=done.returncode, out=done.stdout, err=done.stderr, calls=calls)


def invalidations(calls):
    """Each CloudFront invalidation's sorted paths and its caller reference, as the AWS CLI reads `--paths=` or the
    shorthand batch."""
    found = []
    for call in calls:
        if call[:2] != ['cloudfront', 'create-invalidation']:
            continue
        for arg in call:
            batch = re.fullmatch(r'--invalidation-batch=Paths=\{Quantity=(\d+),Items=\[(.*)\]\},'
                                 r'CallerReference=(\w+)', arg)
            if batch:
                paths = batch.group(2).split(',')
                assert int(batch.group(1)) == len(paths)
                found.append((sorted(paths), batch.group(3)))
            elif arg.startswith('--paths='):
                found.append(([arg.removeprefix('--paths=')], None))
    return found


def test_a_release_invalidates_only_the_names_without_a_content_hash(pwsh, site, tmp_path):
    done = deploy(pwsh, site, tmp_path, '-SkipBuild', '-SkipProvision')
    assert done.code == 0, done.out + done.err
    assert [paths for paths, _ in invalidations(done.calls)] == [RELEASED]
    assert not [call for call in done.calls if call[0] == 's3api' or call[:2] == ['s3', 'rm']]


def test_a_release_put_back_invalidates_the_same_names_once_more(pwsh, site, tmp_path):
    done = deploy(pwsh, site, tmp_path, '-SkipBuild', '-SkipProvision', api=True)
    assert done.code != 0
    assert 'putting the previous index.html and WebAssembly back' in done.out + done.err
    [(released, first), (restored, second)] = invalidations(done.calls)
    assert released == restored == RELEASED and first != second


def test_prune_lists_what_the_bucket_holds_beyond_the_build_and_deletes_nothing(pwsh, site, tmp_path):
    done = deploy(pwsh, site, tmp_path, '-SkipBuild', '-SkipProvision', '-Prune')
    assert done.code == 0, done.out + done.err
    listed = {line.removeprefix('Not in this build: ') for line in done.out.splitlines()
              if line.startswith('Not in this build: ')}
    assert listed == STALE
    assert [call[call.index('--query') + 1] for call in done.calls if call[0] == 's3api'] == ['Contents[].Key']
    assert not [call for call in done.calls if call[:2] == ['s3', 'rm']]
    assert len(invalidations(done.calls)) == 1


def test_prune_apply_deletes_them_and_clears_the_edges(pwsh, site, tmp_path):
    done = deploy(pwsh, site, tmp_path, '-SkipBuild', '-SkipProvision', '-Prune', '-Apply')
    assert done.code == 0, done.out + done.err
    removed = [call[2] for call in done.calls if call[:2] == ['s3', 'rm']]
    assert sorted(removed) == sorted(f's3://site-bucket/{key}' for key in STALE)
    assert invalidations(done.calls)[-1] == (['/*'], None)


def test_prune_apply_deletes_nothing_once_another_release_is_live(pwsh, site, tmp_path):
    # A release that went up meanwhile holds files this build does not.
    done = deploy(pwsh, site, tmp_path, '-SkipBuild', '-SkipProvision', '-Prune', '-Apply',
                  live={'git_commit': 'e' * 40})
    assert done.code != 0
    assert 'e' * 40 in done.out + done.err
    assert not [call for call in done.calls if call[:2] == ['s3', 'rm']]


@pytest.mark.parametrize('flags', [('-Apply',), ('-Prune', '-ProvisionOnly'), ('-Prune', '-Preview')])
def test_prune_comes_only_after_a_release(pwsh, site, tmp_path, flags):
    done = deploy(pwsh, site, tmp_path, *flags)
    assert done.code != 0
    assert '-Prune' in done.err
    assert done.calls == []


@pytest.mark.parametrize('server, origin', [
    (None, []),
    (SERVER, ['ApiVpcOriginId=vo-0123456789abcdef0', 'ApiPrivateDns=ip-10-0-0-1.ap-northeast-2.compute.internal'])])
def test_the_api_origin_follows_the_server_stack_and_without_it_the_site_deploys_static_only(pwsh, site, tmp_path,
                                                                                             server, origin):
    stacks = {'mogaesup-server': server} if server else {}
    done = deploy(pwsh, site, tmp_path, '-SkipBuild', "-DomainName ''", stacks=stacks)
    assert done.code == 0, done.out + done.err
    [provision] = [call for call in done.calls if call[:2] == ['cloudformation', 'deploy']]
    given = provision[provision.index('--parameter-overrides') + 1:]
    overrides = list(itertools.takewhile(lambda arg: not arg.startswith('--'), given))
    assert overrides == ['BucketName=mogaesup-web-960243570517-apne2', *origin]
