#!/usr/bin/env python3
"""Moves the live studio's records from S3 JSON into PostgreSQL, on the studio instance over SSM.

Uses the running release's image (`python -m src.records`): applies the schema, dry-runs the import, then — only while
the studio reports no paid requests or running tasks — stops the container, imports every record of the studio's `assets`
prefix (the local prop sandbox `mogaesup-props` stays in S3), imports again to confirm nothing is left, and names the records database in
/etc/asset-studio.env so the next `deploy-aws.ps1` starts the studio on it. The container stays stopped until then.
The import also leaves a marker object (`<prefix>/.records-in-database`) in S3: from then on a server of that prefix that
starts without CHARACTER_DATABASE_URL refuses to start instead of reading the stale S3 records.
Nothing secret reaches this machine: the URL is built on the instance from the server stack's CharacterDatabaseSecret.
The database URL stays on the instance: in a root-only file the one-off containers mount, never on a command line or in
a container's environment (`ps`, `docker inspect`).
Usage: python backend/infra/records-to-postgres.py [--instance i-…]   (then deploy a release whose deploy-on-instance.sh
reads the config; the instance defaults to the studio stack's)
"""
import argparse
import json
import subprocess
import time

REGION = 'ap-northeast-2'
SERVER_STACK = 'mogaesup-server'
STUDIO_STACK = 'gaesup-asset-studio'
# The command's own limit (executionTimeout), and how long its invocation is waited for past it.
COMMAND_SECONDS = 3600
COMMAND_WAIT = COMMAND_SECONDS + 120

SCRIPT = r'''
set -euo pipefail
. /etc/asset-studio.env
umask 077
URL_FILE=$(mktemp /var/tmp/records-url.XXXXXX)
trap 'rm -f "$URL_FILE"' EXIT
restart() { echo "failed; starting the studio again on S3 records"; docker start gaesup-asset-studio >/dev/null || true; }
trap restart ERR
URL=$(aws secretsmanager get-secret-value --secret-id '{secret}' --query SecretString --output text --region "$AWS_REGION" | python3 -c '
import json, sys, urllib.parse
db = json.load(sys.stdin)
print("postgresql://%s:%s@%s:5432/%s?sslmode=require" % (urllib.parse.quote(db["username"], safe=""), urllib.parse.quote(db["password"], safe=""), sys.argv[1], db["dbname"]))' '{host}')
printf '%s' "$URL" > "$URL_FILE"
unset URL
IMAGE=$(docker inspect -f '{{.Config.Image}}' gaesup-asset-studio)
rec() { docker run --rm --network host -e ASSET_S3_BUCKET="$ASSET_S3_BUCKET" -e ASSET_S3_REGION="$AWS_REGION" -e AWS_REGION="$AWS_REGION" -v "$URL_FILE:/run/records-url:ro" "$IMAGE" python -c 'import os, runpy, sys
os.environ["CHARACTER_DATABASE_URL"] = open("/run/records-url").read().strip()
sys.argv = ["src.records", *sys.argv[1:]]
runpy.run_module("src.records", run_name="__main__")' "$@"; }
rec migrate
rec import --prefix assets --dry-run | tail -8
busy=$(curl -s --max-time 5 http://127.0.0.1:8080/api/health | python3 -c 'import json,sys; a=json.load(sys.stdin).get("activity") or {}; print(int(a.get("paid_requests",0))+int(a.get("running_tasks",0)))')
[ "$busy" = 0 ] || { echo "studio is busy ($busy); try again when idle"; trap - ERR; exit 3; }
docker stop gaesup-asset-studio >/dev/null
rec import --prefix assets | tail -8
echo "second pass:"; rec import --prefix assets | tail -4
rec status | tail -8
grep -q '^CHARACTER_DB_SECRET_ARN=' /etc/asset-studio.env || printf "CHARACTER_DB_SECRET_ARN='%s'\nCHARACTER_DB_HOST='%s'\n" '{secret}' '{host}' >> /etc/asset-studio.env
trap - ERR
echo "imported; the studio stays stopped until the next deploy starts it on the records database"
'''


def aws(*args):
    return json.loads(subprocess.check_output(['aws', *args, '--region', REGION, '--output', 'json']))


def stack_outputs(name):
    return {item['OutputKey']: item['OutputValue']
            for item in aws('cloudformation', 'describe-stacks', '--stack-name', name)['Stacks'][0]['Outputs']}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--instance', help="the studio instance (default: the studio stack's InstanceId output)")
    args = parser.parse_args()
    instance = args.instance or stack_outputs(STUDIO_STACK)['InstanceId']
    outputs = stack_outputs(SERVER_STACK)
    script = SCRIPT.replace('{secret}', outputs['CharacterDatabaseSecretArn']).replace('{host}', outputs['DatabaseEndpoint'])
    parameters = json.dumps({'commands': ["cat > /var/tmp/records-to-postgres.sh <<'MOVE'", *script.strip().splitlines(), 'MOVE',
                                          'bash /var/tmp/records-to-postgres.sh; status=$?; rm -f /var/tmp/records-to-postgres.sh; exit $status'],
                             'executionTimeout': [str(COMMAND_SECONDS)]})
    command = aws('ssm', 'send-command', '--instance-ids', instance, '--document-name', 'AWS-RunShellScript',
                  '--parameters', parameters, '--timeout-seconds', '600', '--comment', 'studio records to PostgreSQL')['Command']['CommandId']
    # Bounded: a lookup that keeps failing, or a command that never ends, stops the wait instead of hanging here.
    deadline = time.monotonic() + COMMAND_WAIT
    result = None
    while True:
        time.sleep(10)
        try:
            result = aws('ssm', 'get-command-invocation', '--command-id', command, '--instance-id', instance)
        except subprocess.CalledProcessError:
            result = None
        if result and result['Status'] not in ('Pending', 'InProgress', 'Delayed'):
            break
        if time.monotonic() > deadline:
            raise SystemExit(f'SSM command {command} did not finish within {COMMAND_WAIT} s; inspect it before running again')
    print(result['StandardOutputContent'], result['StandardErrorContent'])
    if result['Status'] != 'Success':
        raise SystemExit(f"failed: {result['Status']}")
    # The script appended the config lines on this instance; the stack's UserData writes them itself when its parameters
    # name the database, so an instance the stack replaces starts on the records database as well.
    print(f"Give the studio stack (backend/infra/ec2.yaml) CharacterDbSecretArn={outputs['CharacterDatabaseSecretArn']} "
          f"CharacterDbHost={outputs['DatabaseEndpoint']}")


if __name__ == '__main__':
    main()
