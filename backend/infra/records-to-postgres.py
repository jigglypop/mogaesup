#!/usr/bin/env python3
"""Moves the live studio's records from S3 JSON into PostgreSQL, on the studio instance over SSM.

Uses the running release's image (`python -m src.records`): applies the schema, dry-runs the import, then — only while
the studio reports no paid requests or running tasks — stops the container, imports every record of the studio's `assets`
prefix (the local prop sandbox `mogaesup-props` stays in S3), imports again to confirm nothing is left, and names the records database in
/etc/asset-studio.env so the next `deploy-aws.ps1` starts the studio on it. The container stays stopped until then.
The import also leaves a marker object (`<prefix>/.records-in-database`) in S3: from then on a server of that prefix that
starts without CHARACTER_DATABASE_URL refuses to start instead of reading the stale S3 records.
Nothing secret reaches this machine: the URL is built on the instance from the server stack's CharacterDatabaseSecret.
Usage: python backend/infra/records-to-postgres.py   (then deploy a release whose deploy-on-instance.sh reads the config)
"""
import json
import subprocess
import time

REGION = 'ap-northeast-2'
INSTANCE = 'i-00381416eff810818'
SERVER_STACK = 'mogaesup-server'

SCRIPT = r'''
set -euo pipefail
. /etc/asset-studio.env
restart() { echo "failed; starting the studio again on S3 records"; docker start gaesup-asset-studio >/dev/null || true; }
trap restart ERR
URL=$(aws secretsmanager get-secret-value --secret-id '{secret}' --query SecretString --output text --region "$AWS_REGION" | python3 -c '
import json, sys, urllib.parse
db = json.load(sys.stdin)
print("postgresql://%s:%s@%s:5432/%s?sslmode=require" % (urllib.parse.quote(db["username"], safe=""), urllib.parse.quote(db["password"], safe=""), sys.argv[1], db["dbname"]))' '{host}')
IMAGE=$(docker inspect -f '{{.Config.Image}}' gaesup-asset-studio)
rec() { docker run --rm --network host -e ASSET_S3_BUCKET="$ASSET_S3_BUCKET" -e ASSET_S3_REGION="$AWS_REGION" -e AWS_REGION="$AWS_REGION" -e CHARACTER_DATABASE_URL="$URL" "$IMAGE" python -m src.records "$@"; }
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


def main():
    outputs = {item['OutputKey']: item['OutputValue']
               for item in aws('cloudformation', 'describe-stacks', '--stack-name', SERVER_STACK)['Stacks'][0]['Outputs']}
    script = SCRIPT.replace('{secret}', outputs['CharacterDatabaseSecretArn']).replace('{host}', outputs['DatabaseEndpoint'])
    parameters = json.dumps({'commands': ["cat > /var/tmp/records-to-postgres.sh <<'MOVE'", *script.strip().splitlines(), 'MOVE',
                                          'bash /var/tmp/records-to-postgres.sh; status=$?; rm -f /var/tmp/records-to-postgres.sh; exit $status'],
                             'executionTimeout': ['3600']})
    command = aws('ssm', 'send-command', '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript',
                  '--parameters', parameters, '--timeout-seconds', '600', '--comment', 'studio records to PostgreSQL')['Command']['CommandId']
    while True:
        time.sleep(10)
        try:
            result = aws('ssm', 'get-command-invocation', '--command-id', command, '--instance-id', INSTANCE)
        except subprocess.CalledProcessError:
            continue
        if result['Status'] not in ('Pending', 'InProgress', 'Delayed'):
            break
    print(result['StandardOutputContent'], result['StandardErrorContent'])
    if result['Status'] != 'Success':
        raise SystemExit(f"failed: {result['Status']}")
    # The script appended the config lines on this instance; the stack's UserData writes them itself when its parameters
    # name the database, so an instance the stack replaces starts on the records database as well.
    print(f"Give the studio stack (backend/infra/ec2.yaml) CharacterDbSecretArn={outputs['CharacterDatabaseSecretArn']} "
          f"CharacterDbHost={outputs['DatabaseEndpoint']}")


if __name__ == '__main__':
    main()
