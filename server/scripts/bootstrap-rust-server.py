#!/usr/bin/env python3
"""Runs via SSM on the mogaesup-server instance: app database role, server.env and the systemd unit.

No secret is printed or bundled; credentials stay in root-readable files under /etc/mogaesup.
"""
import argparse
import json
import os
import secrets
import subprocess
import urllib.parse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--secret', required=True)
parser.add_argument('--ticket-secret', required=True)
parser.add_argument('--endpoint', required=True)
parser.add_argument('--origin', required=True)
parser.add_argument('--factory-url', default='')
parser.add_argument('--model-store', required=True)
parser.add_argument('--region', default='ap-northeast-2')
args = parser.parse_args()


def secret_value(arn):
    return json.loads(subprocess.check_output(
        ['aws', 'secretsmanager', 'get-secret-value', '--secret-id', arn, '--region', args.region]))['SecretString']


master = json.loads(secret_value(args.secret))
ticket_secret = secret_value(args.ticket_secret)
if len(ticket_secret.encode()) < 32:
    raise RuntimeError('Realtime ticket secret is too short')
root = Path('/opt/mogaesup')
config = Path('/etc/mogaesup')
config.mkdir(mode=0o700, exist_ok=True)
password_file = config / 'app-password'
if not password_file.exists():
    password_file.write_text(secrets.token_hex(32))
    password_file.chmod(0o600)
password = password_file.read_text().strip()
env = os.environ.copy()
env['PGPASSWORD'] = master['password']
env['PGSSLMODE'] = 'verify-full'
env['PGSSLROOTCERT'] = str(root / 'global-bundle.pem')
# The app role owns what its migrations create; the master account stays out of the service.
sql = """DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mogaesup_app') THEN
CREATE ROLE mogaesup_app LOGIN PASSWORD '%s';
END IF; END $$;
ALTER ROLE mogaesup_app LOGIN PASSWORD '%s';
GRANT CONNECT ON DATABASE mogaesup TO mogaesup_app;
GRANT USAGE, CREATE ON SCHEMA public TO mogaesup_app;
""" % (password, password)
subprocess.run(['psql', '-h', args.endpoint, '-U', master['username'], '-d', 'mogaesup', '-v', 'ON_ERROR_STOP=1'],
               input=sql, text=True, env=env, check=True, stdout=subprocess.DEVNULL)
url = (f"postgres://mogaesup_app:{urllib.parse.quote(password, safe='')}@{args.endpoint}:5432/mogaesup"
       f"?sslmode=verify-full&sslrootcert={root}/global-bundle.pem")
origins = [value.strip() for value in args.origin.split(',') if value.strip()]
lines = [f'DATABASE_URL={url}', 'LISTEN_ADDR=0.0.0.0:8080', f"APP_ORIGIN={','.join(dict.fromkeys(origins))}",
         'COOKIE_SECURE=true', f'REALTIME_TICKET_SECRET={ticket_secret}', f'MODEL_STORE={args.model_store}',
         f'AWS_REGION={args.region}', 'RUST_LOG=info']
if args.factory_url:
    lines.append(f'FACTORY_URL={args.factory_url}')
(config / 'server.env').write_text('\n'.join(lines) + '\n')
(config / 'server.env').chmod(0o600)
service = '''[Unit]
Description=Mogaesup Rust server
Wants=network-online.target
After=network-online.target
[Service]
User=mogaesup
Group=mogaesup
WorkingDirectory=/opt/mogaesup
EnvironmentFile=/etc/mogaesup/server.env
ExecStart=/opt/mogaesup/mogaesup-server
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/mogaesup
ProtectHome=true
PrivateTmp=true
MemoryMax=1200M
TasksMax=128
LimitNOFILE=4096
[Install]
WantedBy=multi-user.target
'''
Path('/etc/systemd/system/mogaesup.service').write_text(service)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', 'mogaesup'], check=True)
subprocess.run(['systemctl', 'restart', 'mogaesup'], check=True)
print('Application role and service installed. Credentials stay in root-readable configuration.')
