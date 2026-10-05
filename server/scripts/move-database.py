#!/usr/bin/env python3
"""Moves the mogaesup database to another PostgreSQL instance (e.g. the shared choketmon-postgres), on the server.

Runs over SSM on the server instance, which reaches both instances and reads both master secrets; no secret comes to
this machine or into the command output. It creates the `mogaesup` database and the `mogaesup_app` role (with the
password the server already uses) on the target, refuses a target that already has tables, stops the service, copies
everything with pg_dump/pg_restore as the app role, compares every table's row count, and leaves the service stopped
on success so `deploy-rust-server.py --skip-provision` can start it against the new outputs. On failure it starts the
service again on the old database. Provision the stack with the Shared* parameters first (security group rule, IAM)
and DatabaseAdminAccess=true (the instance role reads the master secrets only then); set it back to false after.
"""
import argparse
import json
import subprocess
import time

REGION = 'ap-northeast-2'
STACK = 'mogaesup-server'
# The SSM command's own limit, and how long its invocation is waited for past it.
COMMAND_SECONDS = 1800
COMMAND_WAIT = COMMAND_SECONDS + 120

SCRIPT = r'''
set -euo pipefail
# The dump holds every account and island: only root reads it, and it is gone however the script ends.
umask 077
trap 'rm -f /var/tmp/mogaesup.dump' EXIT
export PGSSLMODE=verify-full PGSSLROOTCERT=/opt/mogaesup/global-bundle.pem
restore_service() { echo "failed; starting the service on the old database"; systemctl start mogaesup.service || true; }
trap restore_service ERR
secret() { aws secretsmanager get-secret-value --region {region} --secret-id "$1" --query SecretString --output text; }
field() { python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
FROM_JSON=$(secret '{from_secret}'); TO_JSON=$(secret '{to_secret}')
FROM_USER=$(field username <<<"$FROM_JSON"); FROM_PW=$(field password <<<"$FROM_JSON")
TO_USER=$(field username <<<"$TO_JSON"); TO_PW=$(field password <<<"$TO_JSON")
APP_PW=$(cat /etc/mogaesup/app-password)
FROM='{from_endpoint}'; TO='{to_endpoint}'
from_sql() { PGPASSWORD="$FROM_PW" psql -h "$FROM" -U "$FROM_USER" -d mogaesup -v ON_ERROR_STOP=1 -Atq "$@"; }
to_admin() { PGPASSWORD="$TO_PW" psql -h "$TO" -U "$TO_USER" -v ON_ERROR_STOP=1 -q "$@"; }
to_app() { PGPASSWORD="$APP_PW" psql -h "$TO" -U mogaesup_app -d mogaesup -v ON_ERROR_STOP=1 -Atq "$@"; }
echo "SELECT 'CREATE DATABASE mogaesup' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'mogaesup')\gexec" | to_admin -d postgres
to_admin -d mogaesup <<SQL
DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mogaesup_app') THEN CREATE ROLE mogaesup_app LOGIN PASSWORD '$APP_PW'; END IF; END \$\$;
ALTER ROLE mogaesup_app LOGIN PASSWORD '$APP_PW';
GRANT CONNECT ON DATABASE mogaesup TO mogaesup_app;
GRANT USAGE, CREATE ON SCHEMA public TO mogaesup_app;
SQL
for extension in $(from_sql -c "SELECT extname FROM pg_extension WHERE extname <> 'plpgsql'"); do
  to_admin -d mogaesup -c "CREATE EXTENSION IF NOT EXISTS \"$extension\""
done
tables=$(to_app -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
[ "$tables" = 0 ] || { echo "target already has $tables tables; refusing"; trap - ERR; exit 3; }
systemctl stop mogaesup.service
PGPASSWORD="$FROM_PW" pg_dump -h "$FROM" -U "$FROM_USER" -d mogaesup -Fc --no-owner --no-privileges -f /var/tmp/mogaesup.dump
PGPASSWORD="$APP_PW" pg_restore -h "$TO" -U mogaesup_app -d mogaesup --no-owner --no-privileges --exit-on-error /var/tmp/mogaesup.dump
rm -f /var/tmp/mogaesup.dump
for table in $(from_sql -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1"); do
  before=$(from_sql -c "SELECT count(*) FROM public.\"$table\"")
  after=$(to_app -c "SELECT count(*) FROM public.\"$table\"")
  echo "$table $before $after"
  [ "$before" = "$after" ] || { echo "row count differs in $table"; false; }
done
trap - ERR
echo "moved; the service stays stopped until the next deploy starts it on the new database"
'''


def aws(*args):
    return json.loads(subprocess.check_output(['aws', *args, '--region', REGION, '--output', 'json']))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--to-endpoint', required=True)
    parser.add_argument('--to-secret', required=True)
    args = parser.parse_args()
    rds = aws('rds', 'describe-db-instances', '--db-instance-identifier', 'mogaesup-postgres')['DBInstances'][0]
    outputs = {item['OutputKey']: item['OutputValue']
               for item in aws('cloudformation', 'describe-stacks', '--stack-name', STACK)['Stacks'][0]['Outputs']}
    script = SCRIPT.replace('{region}', REGION).replace('{from_secret}', rds['MasterUserSecret']['SecretArn']) \
        .replace('{to_secret}', args.to_secret).replace('{from_endpoint}', rds['Endpoint']['Address']) \
        .replace('{to_endpoint}', args.to_endpoint)
    parameters = json.dumps({'commands': ['umask 077', 'cat > /var/tmp/move-database.sh <<\'MOVE\'', *script.strip().splitlines(),
                                          'MOVE',
                                          'bash /var/tmp/move-database.sh; status=$?; rm -f /var/tmp/move-database.sh; exit $status'],
                             'executionTimeout': [str(COMMAND_SECONDS)]})
    command = aws('ssm', 'send-command', '--instance-ids', outputs['InstanceId'], '--document-name', 'AWS-RunShellScript',
                  '--parameters', parameters, '--comment', 'mogaesup database move')['Command']['CommandId']
    deadline = time.monotonic() + COMMAND_WAIT
    while True:
        time.sleep(5)
        try:
            result = aws('ssm', 'get-command-invocation', '--command-id', command, '--instance-id', outputs['InstanceId'])
        except subprocess.CalledProcessError:
            result = None
        if result and result['Status'] not in ('Pending', 'InProgress', 'Delayed'):
            break
        if time.monotonic() > deadline:
            raise SystemExit(f'move did not finish within {COMMAND_WAIT} s; inspect SSM command {command} on the instance')
    print(result['StandardOutputContent'])
    if result['StandardErrorContent'].strip():
        print(result['StandardErrorContent'])
    if result['Status'] != 'Success':
        raise SystemExit(f"move failed: {result['Status']}")


if __name__ == '__main__':
    main()
