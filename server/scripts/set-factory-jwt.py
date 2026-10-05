#!/usr/bin/env python3
"""Gives the server's studio gateway and the character studio one shared token key, in the order that keeps both up.

The gateway signs a Bearer token for each studio request once server.env has FACTORY_JWT_SECRET (server/src/config.rs);
the studio verifies it with JWT_SECRET from its provider secret, and answers 503 to a token it cannot verify. So the
studio gets the key first and is redeployed with it (its running release again, through backend/infra/deploy-aws.ps1:
drain, health check, rollback), and only then does the server start signing:

    1. JWT_SECRET into the studio provider secret (an existing one is reused; a new one is random and never printed);
    2. the studio redeployed with it, unless the running container already has it;
    3. FACTORY_JWT_SECRET into the server's server.env and the server restarted (the old file comes back if it does not
       answer), unless it already has the same key; the value travels through a private object in the server's
       runtime bucket that is deleted afterwards, never through a command line, SSM parameters or output;
    4. https://mogaesup.com/api/health checked.

Only fingerprints (the first 12 hex digits of a SHA-256) are printed. Without --execute it reads and shows the plan.

    uv run python server/scripts/set-factory-jwt.py [--execute]      (boto3 from the repository uv environment)
"""
import argparse
import hashlib
import json
import re
import secrets
import shutil
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REGION = 'ap-northeast-2'
ACCOUNT = '960243570517'
SERVER_STACK = 'mogaesup-server'
STUDIO_STACK = 'gaesup-asset-studio'
SITE = 'https://mogaesup.com'
KEY = re.compile(r'[A-Za-z0-9_-]{32,256}')
COMMAND_SECONDS = 1200

# Prints what the running studio container verifies with and the release it runs; no secret.
STUDIO_STATE = r'''
set -eu
python3 - <<'PY'
import json, hashlib, subprocess
try:
    provider = json.loads(subprocess.run(['docker', 'exec', 'gaesup-asset-studio', 'cat', '/run/studio-secrets.json'],
                                         check=True, capture_output=True).stdout)
    value = str(provider.get('JWT_SECRET') or '')
except (subprocess.CalledProcessError, ValueError):
    value = None
print('jwt=' + ('missing-container' if value is None else hashlib.sha256(value.encode()).hexdigest()[:12] if value else 'none'))
print('release=' + json.load(open('/opt/asset-studio/current.json'))['release_key'])
PY
'''

# Prints what server.env holds; no secret.
SERVER_STATE = r'''
set -eu
python3 - <<'PY'
import hashlib, re
text = open('/etc/mogaesup/server.env').read()
def get(name):
    found = re.search(r'^%s=(.*)$' % name, text, re.M)
    return found.group(1).strip() if found else ''
value = get('FACTORY_JWT_SECRET')
print('jwt=' + (hashlib.sha256(value.encode()).hexdigest()[:12] if value else 'none'))
print('factory_url=' + ('set' if get('FACTORY_URL') else 'none'))
PY
'''

# Writes FACTORY_JWT_SECRET from the private object into server.env and restarts the server, under the install lock;
# the previous file comes back when the server does not answer.
SERVER_SET = r'''
set -eu
umask 077
exec 9>/var/lock/mogaesup-install.lock
flock -n 9 || { echo 'an install is running; try again after it' >&2; exit 3; }
tmp=$(mktemp /root/factory-jwt.XXXXXX)
trap 'rm -f "$tmp"' EXIT
aws s3 cp 's3://{bucket}/{key}' "$tmp" --region {region} --only-show-errors
cp -p /etc/mogaesup/server.env /etc/mogaesup/server.env.jwt-prev
python3 - "$tmp" <<'PY'
import os, re, sys
value = open(sys.argv[1]).read().strip()
if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', value):
    raise SystemExit('the shared key is not valid')
path = '/etc/mogaesup/server.env'
lines = [line for line in open(path).read().splitlines() if not line.startswith('FACTORY_JWT_SECRET=')]
if not any(line.startswith('FACTORY_URL=') and line.split('=', 1)[1].strip() for line in lines):
    raise SystemExit('server.env has no FACTORY_URL: the studio gateway is off, so there is nothing to sign for')
with open(path + '.new', 'w') as out:
    out.write('\n'.join(lines + ['FACTORY_JWT_SECRET=' + value]) + '\n')
os.chmod(path + '.new', 0o600)
os.replace(path + '.new', path)
PY
systemctl restart mogaesup.service
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:8080/api/health >/dev/null; then echo 'server answers with FACTORY_JWT_SECRET'; exit 0; fi
  sleep 2
done
echo 'the server did not answer; putting the previous server.env back' >&2
cp -p /etc/mogaesup/server.env.jwt-prev /etc/mogaesup/server.env
systemctl restart mogaesup.service || true
exit 1
'''


class Aws:
    """The calls this script makes, through boto3: a secret value never becomes a command-line argument or a file."""

    def __init__(self):
        import boto3
        from botocore.config import Config
        session = boto3.Session(region_name=REGION)
        config = Config(connect_timeout=10, read_timeout=60, retries={'total_max_attempts': 3})
        self.client = lambda name: session.client(name, config=config)

    def account(self):
        return self.client('sts').get_caller_identity()['Account']

    def stack(self, name):
        found = self.client('cloudformation').describe_stacks(StackName=name)['Stacks'][0]
        return ({item['OutputKey']: item['OutputValue'] for item in found.get('Outputs', [])},
                {item['ParameterKey']: item.get('ParameterValue', '') for item in found.get('Parameters', [])})

    def run_on(self, instance, script, comment):
        """Runs `script` on the instance over SSM and returns its output lines; a failure raises with its error output."""
        ssm = self.client('ssm')
        command = ssm.send_command(InstanceIds=[instance], DocumentName='AWS-RunShellScript', Comment=comment,
                                   Parameters={'commands': [script], 'executionTimeout': [str(COMMAND_SECONDS)]},
                                   )['Command']['CommandId']
        deadline = time.monotonic() + COMMAND_SECONDS + 120
        while True:
            time.sleep(5)
            try:
                result = ssm.get_command_invocation(CommandId=command, InstanceId=instance)
            except Exception:  # not registered yet, throttled: asked again until the deadline
                result = None
            if result and result['Status'] not in ('Pending', 'InProgress', 'Delayed'):
                break
            if time.monotonic() > deadline:
                raise RuntimeError(f'SSM command {command} did not finish; inspect it before running again')
        if result['Status'] != 'Success':
            raise RuntimeError(f"{comment} failed ({result['Status']}): {result.get('StandardErrorContent', '')[-1500:]}")
        return result.get('StandardOutputContent', '').splitlines()


def fingerprint(value):
    return hashlib.sha256(value.encode()).hexdigest()[:12] if value else 'none'


def fields(lines):
    return dict(line.split('=', 1) for line in lines if '=' in line)


def redeploy_studio(instance, bucket, release):
    shell = shutil.which('pwsh') or shutil.which('powershell')
    if not shell:
        raise RuntimeError('PowerShell is needed for backend/infra/deploy-aws.ps1')
    subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(ROOT / 'backend/infra/deploy-aws.ps1'),
                    '-InstanceId', instance, '-Bucket', bucket, '-ReleaseKey', release], check=True)


def plan(fresh, want, studio_state, server_state):
    """The steps still to do, in their order: the studio has to verify the key before the server signs with it."""
    if server_state.get('factory_url') != 'set':
        raise SystemExit('server.env has no FACTORY_URL: the studio gateway is off, so the server signs nothing')
    steps = []
    if fresh:
        steps.append(('secret', f'put a new JWT_SECRET ({want}) into the studio provider secret'))
    if fresh or studio_state.get('jwt') != want:
        steps.append(('studio', f"redeploy the studio's release {studio_state.get('release')} "
                                f"(its container has {studio_state.get('jwt')})"))
    if server_state.get('jwt') != want:
        steps.append(('server', f"set FACTORY_JWT_SECRET ({want}) in server.env (now {server_state.get('jwt')}) and "
                                'restart the server'))
    return steps


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--execute', action='store_true', help='make the changes (without it: read and show the plan)')
    args = parser.parse_args()
    cloud = Aws()
    if cloud.account() != ACCOUNT:
        raise RuntimeError('Unexpected AWS account')
    server_outputs, _ = cloud.stack(SERVER_STACK)
    studio_outputs, studio_parameters = cloud.stack(STUDIO_STACK)
    provider_arn = studio_parameters['ProviderSecretArn']
    server, studio = server_outputs['InstanceId'], studio_outputs['InstanceId']
    secrets_manager = cloud.client('secretsmanager')

    provider = secrets_manager.get_secret_value(SecretId=provider_arn)
    settings = json.loads(provider['SecretString'])
    value = str(settings.get('JWT_SECRET') or '').strip()
    fresh = not KEY.fullmatch(value)
    if fresh:
        value = secrets.token_urlsafe(48)
    want = fingerprint(value)
    studio_state = fields(cloud.run_on(studio, STUDIO_STATE, 'studio JWT state'))
    server_state = fields(cloud.run_on(server, SERVER_STATE, 'server JWT state'))
    steps = plan(fresh, want, studio_state, server_state)
    print(f"studio container: {studio_state.get('jwt')}, server: {server_state.get('jwt')}, shared key: "
          f"{want}{' (new)' if fresh else ''}")
    if not steps:
        print('Nothing to do: the studio and the server share the key.')
        return
    for number, (_, step) in enumerate(steps, 1):
        print(f'{number}. {step}')
    if not args.execute:
        print('Nothing was changed; run again with --execute.')
        return

    todo = {name for name, _ in steps}
    if 'secret' in todo:
        current = secrets_manager.describe_secret(SecretId=provider_arn)['VersionIdsToStages']
        if 'AWSCURRENT' not in current.get(provider['VersionId'], []):
            raise RuntimeError('The studio provider secret changed while this ran; run again')
        settings['JWT_SECRET'] = value
        written = secrets_manager.put_secret_value(SecretId=provider_arn, ClientRequestToken=str(uuid.uuid4()),
                                                   SecretString=json.dumps(settings))
        stages = secrets_manager.describe_secret(SecretId=provider_arn)['VersionIdsToStages']
        if 'AWSPREVIOUS' not in stages.get(provider['VersionId'], []):
            raise RuntimeError('Another change reached the studio provider secret at the same time; inspect its '
                               f"versions (this one is {written['VersionId']}) before running again")
        print('studio provider secret: JWT_SECRET set')
    if 'studio' in todo:
        redeploy_studio(studio, studio_parameters['AssetBucket'], studio_state['release'])
        after = fields(cloud.run_on(studio, STUDIO_STATE, 'studio JWT state'))
        if after.get('jwt') != want:
            raise SystemExit(f"The studio runs with {after.get('jwt')}, not {want}; the server was left as it is")
    if 'server' in todo:
        s3 = cloud.client('s3')
        bucket, key = server_outputs['RuntimeBucket'], f'config/factory-jwt-{uuid.uuid4().hex}'
        s3.put_object(Bucket=bucket, Key=key, Body=value.encode(), ServerSideEncryption='AES256')
        try:
            for line in cloud.run_on(server, SERVER_SET.replace('{bucket}', bucket).replace('{key}', key)
                                     .replace('{region}', REGION), 'server FACTORY_JWT_SECRET'):
                print(line)
        finally:
            # Every version of the object, so the key does not stay behind in the versioned bucket.
            versions = s3.list_object_versions(Bucket=bucket, Prefix=key)
            for item in versions.get('Versions', []) + versions.get('DeleteMarkers', []):
                s3.delete_object(Bucket=bucket, Key=key, VersionId=item['VersionId'])
    request = urllib.request.Request(f'{SITE}/api/health', headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=20) as response:
        health = json.loads(response.read())
    if health.get('status') != 'ok':
        raise SystemExit(f'{SITE}/api/health: {health}')
    print(f'{SITE}/api/health ok; the studio and the server share the key {want}')


if __name__ == '__main__':
    main()
