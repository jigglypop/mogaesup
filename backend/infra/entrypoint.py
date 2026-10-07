"""Single-owner deployment: the API through SSM port forwarding, or through CloudFront when configured.

    python /app/entrypoint.py                    the API and nginx (the container's command)
    python /app/entrypoint.py --share-data
        the whole data root shared with the workers' group; deploy-on-instance.sh runs it in the new image before the
        worker check, with what its time limit leaves (the first time it changes every entry; one cut short is carried
        on by the next, as what it changed stays changed)
    python /app/entrypoint.py --check-workers [--metadata-guard]
        Blender starts as its worker user and writes where the API leaves work: the pipeline runs it in the studio
        image, deploy-on-instance.sh in each candidate before it is committed (with --metadata-guard, which also reports
        whether the worker reaches the instance metadata service; that is a warning, the workers still run).
"""
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import uuid

# JWT_SECRET (the app server's FACTORY_JWT_SECRET) lets the API verify the tokens the studio gateway signs, a member's
# wardrobe reads among them (src/auth.py); without it a request that carries a token is refused with 503.
allowed = {'OPENAI_API_KEY', 'MESHY_API_KEY', 'OPENAI_API_BASE', 'AVATAR_IMAGE_MODEL', 'TRIPO_API_KEY',
           'AVATAR_3D_PROVIDER', 'BLENDER_CONCURRENCY', 'CHARACTER_DATABASE_URL', 'STUDIO_GATEWAY_KEY',
           'STUDIO_GATEWAY_KEY_PREVIOUS', 'JWT_SECRET', 'JWT_ISSUER', 'JWT_AUDIENCE'}
# The gateway key is written into nginx's rules: no quote, space, `;`, `$` or anything else nginx would read.
GATEWAY_KEY = re.compile(r'[A-Za-z0-9._~-]{16,}')
GIT_COMMIT = re.compile(r'[0-9a-f]{40}')
# studio-worker, the user every Blender runs as (infra/Dockerfile, infra/blender-worker.py, infra/worker-guard.sh).
WORKER = 10001
# The API's umask: what it creates under the data root is writable by the workers' group too.
API_UMASK = 0o002
METADATA = ('169.254.169.254', 80)


def share_entry(path, bits, gid=WORKER, lstat=os.lstat, chown=getattr(os, 'lchown', None), chmod=os.chmod):
    """One entry of the data root in the workers' group with `bits` added; whether anything had to change. A link is
    left alone and not followed, and an entry gone meanwhile (a workspace the running API cleared) is skipped."""
    try:
        found = lstat(path)
        if stat.S_ISLNK(found.st_mode):
            return False
        changed = False
        if found.st_gid != gid:
            chown(path, -1, gid)
            changed = True
        if stat.S_IMODE(found.st_mode) & bits != bits:
            chmod(path, stat.S_IMODE(found.st_mode) | bits)
            changed = True
        return changed
    except FileNotFoundError:
        return False


def share_with_workers(root, gid=WORKER, lstat=os.lstat, chown=getattr(os, 'lchown', None), chmod=os.chmod):
    """The data root as the API (root) and its Blender workers (studio-worker) share it: every folder the workers' group's,
    group-writable and setgid (what is made in it keeps the group), every file group-writable. Releases before the
    workers had a user of their own left root's folders behind; only what is not so yet is changed, so a restart only
    reads the tree. Returns how many entries it changed."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    changed = share_entry(root, 0o2070, gid, lstat, chown, chmod)
    for folder, folders, files in os.walk(root):
        for name in folders:
            changed += share_entry(os.path.join(folder, name), 0o2070, gid, lstat, chown, chmod)
        for name in files:
            changed += share_entry(os.path.join(folder, name), 0o060, gid, lstat, chown, chmod)
    return int(changed)


def share_runtime(root, gid=WORKER, lstat=os.lstat, chown=getattr(os, 'lchown', None), chmod=os.chmod):
    """What the worker check writes in, and nothing else: the data root itself and its .runtime folder. However large the
    tree, the check takes the same time; the deploy shares the whole of it just before (--share-data) and the API again
    when it starts."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    share_entry(root, 0o2070, gid, lstat, chown, chmod)
    share_entry(root / '.runtime', 0o2070, gid, lstat, chown, chmod)


def share_data(root=None, share=share_with_workers):
    """--share-data: the whole data root shared with the workers' group, and how much of it changed."""
    root = Path(root or os.environ.get('ASSET_DATA_ROOT', '/app/data'))
    changed = share(root)
    print(f"{root} is shared with uid {WORKER}'s group ({changed} entries changed)")
    return 0


def reaches(address, timeout=2):
    try:
        socket.create_connection(address, timeout=timeout).close()
        return True
    except OSError:
        return False


def as_worker(uid=WORKER):
    os.setgroups([])
    os.setresgid(uid, uid, uid)
    os.setresuid(uid, uid, uid)


def check_workers(data_root=None, blender='/usr/local/bin/blender', metadata_guard=False, worker=WORKER,
                  share=share_runtime):
    """0 when Blender, started as the API starts it, runs as studio-worker and can write a file in a folder the API made
    under the data root (only the root and its .runtime are shared here, so the check does not grow with the tree). With
    `metadata_guard` it also says whether that user reaches the instance metadata service while root does
    (infra/worker-guard.sh closes it to the worker); a worker that still reaches it is a warning only."""
    root = Path(data_root or os.environ.get('ASSET_DATA_ROOT', '/app/data'))
    share(root)
    previous = os.umask(API_UMASK)
    try:
        folder = root / '.runtime' / f'worker-check-{uuid.uuid4().hex}'
        folder.mkdir(parents=True)
    finally:
        os.umask(previous)
    target = folder / 'worker.txt'
    try:
        done = subprocess.run(
            [blender, '--background', '--factory-startup', '--python-exit-code', '1', '--python-expr',
             "import os; open(os.environ['STUDIO_WORKER_CHECK'], 'w').write(str(os.getuid()))"],
            env={**os.environ, 'STUDIO_WORKER_CHECK': str(target)}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            timeout=180, umask=API_UMASK)
        written = target.read_text(encoding='utf-8').strip() if target.is_file() else None
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    if done.returncode or written != str(worker):
        tail = done.stderr.decode('utf-8', 'replace').strip().splitlines()[-5:]
        print(f'worker check failed: Blender exited {done.returncode} and wrote {written!r} (want uid {worker}) in '
              f'{root}', *tail, sep='\n', file=sys.stderr)
        return 1
    print(f'Blender runs as uid {worker} and writes under {root}')
    if metadata_guard:
        if not reaches(METADATA):
            print('the instance metadata service does not answer here; nothing to keep the workers from')
        else:
            probe = subprocess.run([sys.executable, '-I', '-c', 'import socket, sys\n'
                                    'try: socket.create_connection(("169.254.169.254", 80), timeout=2).close()\n'
                                    'except OSError: sys.exit(1)'], preexec_fn=lambda: as_worker(worker), timeout=30)
            if probe.returncode == 0:
                print(f'warning: uid {worker} reaches the instance metadata service and with it the role credentials; '
                      'infra/worker-guard.sh did not take effect', file=sys.stderr)
            else:
                print(f'the instance metadata service refuses uid {worker}')
    return 0


def _gate(gateway_key, previous_key):
    """The lines that refuse a request without a valid x-gateway-key. During a key rotation the previous key (the one the
    app server still sends until it restarts with the new one) is accepted as well."""
    if not previous_key:
        return [f'  if ($http_x_gateway_key != "{gateway_key}") {{ return 403; }}']
    return ['  set $studio_gateway 0;',
            *(f'  if ($http_x_gateway_key = "{key}") {{ set $studio_gateway 1; }}' for key in (gateway_key, previous_key)),
            '  if ($studio_gateway = 0) { return 403; }']


def public_rules(public, gateway_key='', previous_key=''):
    """The rules of nginx.conf's port-80 server (/etc/nginx/studio-public.conf): closed unless `public`. With a gateway key
    the API answers 403 to a request that does not send it (or, while rotating, `previous_key`) as x-gateway-key."""
    if not public:
        return ['location /api/ { return 404; }', 'location = /health { return 404; }']
    if not gateway_key or not GATEWAY_KEY.fullmatch(gateway_key):
        raise SystemExit('STUDIO_GATEWAY_KEY must be at least 16 characters of A-Z a-z 0-9 . _ ~ -')
    if previous_key and (previous_key == gateway_key or not GATEWAY_KEY.fullmatch(previous_key)):
        raise SystemExit('STUDIO_GATEWAY_KEY_PREVIOUS must be another key of at least 16 characters of A-Z a-z 0-9 . _ ~ -')
    gate = _gate(gateway_key, previous_key)
    # The API trusts the operator header only for a loopback Host: nginx names the API's own address. A request that
    # carries a token (the studio gateway signs one, MEMBER for a member's wardrobe reads) goes without the header, so
    # the token alone decides who it is; the owner's own requests, which carry none, stay the operator. An empty
    # proxy_set_header value sends no header, and the client's own X-User-Id is never passed on.
    proxy = ['  set $studio_user 1;', '  if ($http_authorization != "") { set $studio_user ""; }',
             '  proxy_pass http://127.0.0.1:8000;', '  proxy_set_header X-User-Id $studio_user;',
             '  proxy_set_header Host 127.0.0.1;',
             '  proxy_set_header Forwarded "";', '  proxy_set_header X-Forwarded-For "";', '  proxy_set_header X-Real-IP "";',
             '  proxy_read_timeout 65s;', '  proxy_buffering off;']
    return [
        'location /api/ {', *gate, *proxy, '}',
        # Raw GLB uploads; the API streams them and caps each at 256 MiB.
        'location ~ ^/api/(avatar-factory/base-bodies/glb-assets|studio/glb-assets/upload)$ {',
        '  client_max_body_size 256m;', *gate, *proxy, '}',
        'location = /health { return 404; }',
    ]


def write_public_rules(path, public, gateway_key, previous_key=''):
    # nginx injects X-User-Id 1 into a request without a token, so without the key whatever reaches port 80 acts as the
    # studio owner.
    path.write_text('\n'.join(public_rules(public, gateway_key, previous_key)) + '\n', encoding='utf-8')
    path.chmod(0o600)


def release_stamp(release_sha, release_file=Path('/app/release.json')):
    """version.json: the release archive's hash, and the git commit it was packed from when prepare-aws.ps1 knew it."""
    stamp = {'release_sha': release_sha}
    try:
        commit = json.loads(release_file.read_text(encoding='utf-8')).get('git_commit')
    except (OSError, ValueError, AttributeError):
        commit = None
    if isinstance(commit, str) and GIT_COMMIT.fullmatch(commit):
        stamp['git_commit'] = commit
    return stamp


def main():
    values = json.loads(Path('/run/studio-secrets.json').read_text())
    if not values.get('OPENAI_API_KEY') or not values.get('MESHY_API_KEY'):
        raise SystemExit('Provider credentials are not configured')
    os.environ.update({key: str(value) for key, value in values.items() if key in allowed})
    if not os.environ.get('ASSET_S3_BUCKET'):
        raise SystemExit('S3 bucket is required')

    release_sha = os.environ.get('STUDIO_RELEASE_SHA', '').strip()
    if not re.fullmatch(r'[0-9a-f]{64}', release_sha):
        raise SystemExit('STUDIO_RELEASE_SHA must be a lowercase SHA-256 digest')
    # The studio screens live in the mogaesup app now; this container serves the API and its release stamp only.
    static = Path('/app/static')
    static.mkdir(parents=True, exist_ok=True)
    (static / 'version.json').write_text(
        json.dumps(release_stamp(release_sha), separators=(',', ':')) + '\n',
        encoding='utf-8',
    )

    # Port 80: closed by default; the API when PUBLIC_STUDIO is set (CloudFront only reaches it). Only nginx needs the
    # gateway keys, so the API and the Blender workers it starts do not inherit them.
    public = os.environ.get('PUBLIC_STUDIO', '').strip().lower() == 'true'
    gateway_key = os.environ.pop('STUDIO_GATEWAY_KEY', '').strip()
    previous_key = os.environ.pop('STUDIO_GATEWAY_KEY_PREVIOUS', '').strip()
    write_public_rules(Path('/etc/nginx/studio-public.conf'), public, gateway_key, previous_key)
    # The Blender workers the API starts run as studio-worker (infra/blender-worker.py) and write under the data root.
    share_with_workers(Path(os.environ.get('ASSET_DATA_ROOT', '/app/data')))
    children = [subprocess.Popen(['python', '-m', 'uvicorn', 'src.api.server:app', '--host', '127.0.0.1', '--port', '8000', '--workers', '1', '--no-proxy-headers'],
                                 umask=API_UMASK),
                subprocess.Popen(['nginx', '-g', 'daemon off;'])]

    def stop(*_):
        for child in children:
            child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while all(child.poll() is None for child in children):
            time.sleep(1)
    finally:
        failed = next((child.returncode for child in children if child.returncode not in (None, 0)), None)
        stop()
        for child in children:
            try: child.wait(timeout=20)
            except subprocess.TimeoutExpired: child.kill()
        if failed is not None:
            raise SystemExit(failed)


if __name__ == '__main__':
    if '--check-workers' in sys.argv[1:]:
        sys.exit(check_workers(metadata_guard='--metadata-guard' in sys.argv[1:]))
    if '--share-data' in sys.argv[1:]:
        sys.exit(share_data())
    main()
