#!/usr/bin/env python3
"""Runs via SSM on the mogaesup-server instance: app database role, server.env and the systemd unit.

No secret is printed or bundled; credentials stay in root-readable files under /etc/mogaesup.
"""
import argparse
import json
import os
import re
import secrets
import subprocess
import urllib.parse
from pathlib import Path

# The studio gateway entries of server.env, in the order they are written. The FACTORY_JWT_* and FACTORY_OWNER_ID ones
# (the tokens the gateway signs for the studio, set by set-factory-jwt.py) are kept as the file has them.
FACTORY_KEYS = ('FACTORY_URL', 'FACTORY_ACCESS', 'FACTORY_PAID_MONTHLY', 'FACTORY_GATEWAY_KEY', 'STUDIO_INSTANCE_ID',
                'FACTORY_JWT_SECRET', 'FACTORY_JWT_ISSUER', 'FACTORY_JWT_AUDIENCE', 'FACTORY_OWNER_ID')
# What the server stack's OpenAiKeySecret holds until the key is set by hand (README "배포").
OPENAI_PLACEHOLDER = 'placeholder'
# A key server.env can carry on its line: OpenAI's keys are letters, digits, '-' and '_'.
OPENAI_KEY = re.compile(r'[A-Za-z0-9_-]{20,512}')
# The OpenAI entries of server.env set by hand on the instance (the models and the monthly budgets), kept as the file has
# them after the key.
OPENAI_KEPT = ('OPENAI_BASE_URL', 'OPENAI_READING_MODEL', 'OPENAI_READING_EFFORT', 'OPENAI_PICTURE_MODEL', 'READINGS_MONTHLY',
               'PICTURES_MONTHLY')


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--secret', required=True)
    parser.add_argument('--ticket-secret', required=True)
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--origin', required=True)
    # A studio flag left out keeps the value server.env has; an empty --factory-url or --studio-instance-id removes it.
    parser.add_argument('--factory-url', default=None)
    parser.add_argument('--factory-access', default=None, choices=('read', 'write', 'paid'))
    parser.add_argument('--factory-paid-monthly', type=int, default=None)
    parser.add_argument('--factory-gateway-secret', default='')
    parser.add_argument('--studio-instance-id', default=None)
    parser.add_argument('--model-store', required=True)
    # The server stack's OpenAiKeySecret. Left out, server.env keeps the OPENAI_API_KEY it has.
    parser.add_argument('--openai-secret', default=None)
    parser.add_argument('--region', default='ap-northeast-2')
    # The install restarts the service itself, once, after it has swapped the binary (deploy-rust-server.py).
    parser.add_argument('--no-restart', action='store_true')
    return parser.parse_args(argv)


def secret_value(arn, region):
    # Bounded: the install runs this with the service stopped, inside SSM's execution timeout.
    return json.loads(subprocess.check_output(
        ['aws', 'secretsmanager', 'get-secret-value', '--secret-id', arn, '--region', region,
         '--cli-connect-timeout', '10', '--cli-read-timeout', '30']))['SecretString']


def read_env(path):
    """The KEY=VALUE pairs of an EnvironmentFile; empty while the file does not exist (the first bootstrap)."""
    if not path.is_file():
        return {}
    values = {}
    for line in path.read_text().splitlines():
        key, separator, value = line.strip().partition('=')
        key, value = key.strip(), value.strip()
        if not separator or not key or key.startswith(('#', ';')):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        values[key] = value
    return values


def factory_settings(existing, args, fetch_gateway_key):
    """The FACTORY_* and STUDIO_INSTANCE_ID entries server.env ends with. An argument that was given decides (empty removes
    it); one that was left out keeps what the file had, so a deploy without the studio flags neither switches the gateway off
    nor sets its access back to read. Without a character server (no FACTORY_URL) none of them applies."""
    settings = {key: value for key, value in existing.items() if key.startswith('FACTORY_') or key == 'STUDIO_INSTANCE_ID'}
    given = {'FACTORY_URL': args.factory_url, 'FACTORY_ACCESS': args.factory_access,
             'FACTORY_PAID_MONTHLY': args.factory_paid_monthly, 'STUDIO_INSTANCE_ID': args.studio_instance_id}
    settings.update({key: str(value) for key, value in given.items() if value is not None})
    if not settings.get('FACTORY_URL'):
        return {}
    settings.setdefault('FACTORY_ACCESS', 'read')
    settings.setdefault('FACTORY_PAID_MONTHLY', '0')
    if args.factory_gateway_secret:
        settings['FACTORY_GATEWAY_KEY'] = fetch_gateway_key()
    order = [key for key in FACTORY_KEYS if key in settings] + [key for key in settings if key not in FACTORY_KEYS]
    return {key: settings[key] for key in order if settings[key] != ''}


def model_sweep(existing):
    """MODEL_SWEEP as server.env has it, so an operator who turned the sweep off keeps it off through every deploy; `on`
    only for a file without it, since this server owns its MODEL_STORE (the site's bucket). Empty is off, as the server
    reads it. Another value would stop the server at its start (and the previous release with it, on the same file):
    nothing is installed until the file says on or off."""
    value = existing.get('MODEL_SWEEP')
    if value is None:
        return 'on'
    if value in ('on', 'off', ''):
        return value or 'off'
    raise RuntimeError(f'server.env has MODEL_SWEEP={value!r}, which the server refuses; set it to on or off on the '
                       'instance (/etc/mogaesup/server.env) and deploy again')


def openai_settings(existing, args, fetch_key):
    """The OpenAI entries server.env ends with, and what the deploy log says of the key. With --openai-secret the secret
    decides: OPENAI_API_KEY is its value once it holds a real key, and there is none while it holds the placeholder (or
    anything that is not a key). Left out, or when the secret cannot be read, the key the file had stays, so a deploy
    that does not name the secret switches nothing off. The entries in OPENAI_KEPT stay as the file has them."""
    key, note = existing.get('OPENAI_API_KEY') or None, 'kept as server.env had it'
    if args.openai_secret:
        try:
            value = fetch_key().strip()
        except subprocess.CalledProcessError:
            note = 'the secret could not be read; kept as server.env had it'
        else:
            if value == OPENAI_PLACEHOLDER:
                key, note = None, 'the secret holds the placeholder'
            elif not OPENAI_KEY.fullmatch(value):
                key, note = None, 'the secret holds no key'
            else:
                key, note = value, 'from the secret'
    settings = {'OPENAI_API_KEY': key} if key else {}
    settings.update({name: existing[name] for name in OPENAI_KEPT if existing.get(name)})
    return settings, note


def describe_openai(settings, note):
    """The deploy log's line about the OpenAI API; the key only as set or not."""
    kept = ''.join(f' {name}={settings[name]}' for name in OPENAI_KEPT if name in settings)
    return f"OpenAI: OPENAI_API_KEY={'set' if settings.get('OPENAI_API_KEY') else 'not set'} ({note}){kept}"


def server_env_lines(args, database_url, ticket_secret, settings, sweep='on', openai=None):
    """server.env, with the model store's sweep as model_sweep() decided and the OpenAI entries openai_settings() found."""
    origins = [value.strip() for value in args.origin.split(',') if value.strip()]
    return [f'DATABASE_URL={database_url}', 'LISTEN_ADDR=0.0.0.0:8080', f"APP_ORIGIN={','.join(dict.fromkeys(origins))}",
            'COOKIE_SECURE=true', f'REALTIME_TICKET_SECRET={ticket_secret}', f'MODEL_STORE={args.model_store}',
            f'MODEL_SWEEP={sweep}', f'AWS_REGION={args.region}', 'RUST_LOG=info',
            *(f'{key}={value}' for key, value in settings.items()),
            *(f'{key}={value}' for key, value in (openai or {}).items())]


def describe_factory(settings):
    """The deploy log's line about the studio gateway; the gateway key only as set or not."""
    if not settings:
        return 'Studio gateway: off (server.env has no FACTORY_URL)'
    shown = ' '.join(f"{key}={settings.get(key) or '(none)'}"
                     for key in ('FACTORY_URL', 'FACTORY_ACCESS', 'FACTORY_PAID_MONTHLY', 'STUDIO_INSTANCE_ID'))
    return (f"Studio gateway: {shown} FACTORY_GATEWAY_KEY={'set' if settings.get('FACTORY_GATEWAY_KEY') else 'not set'} "
            f"FACTORY_JWT_SECRET={'set' if settings.get('FACTORY_JWT_SECRET') else 'not set'}")


SERVICE = '''[Unit]
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


def database_env(root, password):
    env = os.environ.copy()
    env['PGPASSWORD'] = password
    env['PGSSLMODE'] = 'verify-full'
    env['PGSSLROOTCERT'] = str(root / 'global-bundle.pem')
    env.setdefault('PGCONNECT_TIMEOUT', '10')
    return env


def app_role_works(endpoint, env, run=subprocess.run):
    """Whether the app role logs in to its database with the password this instance keeps."""
    done = run(['psql', '-h', endpoint, '-U', 'mogaesup_app', '-d', 'mogaesup', '-v', 'ON_ERROR_STOP=1', '-Atc', 'SELECT 1'],
               text=True, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return done.returncode == 0


def create_app_role(args, root, password):
    """The database and its app role, made with the master account: on the first install, or when the app role no longer
    logs in. Only then is the master secret read, so the instance role needs it only for that (the server stack's
    DatabaseAdminAccess)."""
    try:
        master = json.loads(secret_value(args.secret, args.region))
    except subprocess.CalledProcessError:
        raise RuntimeError('The app database role does not log in, and the database master secret could not be read: '
                           'deploy the server stack with DatabaseAdminAccess=true, run this install again, then set it '
                           'back to false') from None
    env = database_env(root, master['password'])
    # A shared instance (another stack's) has no mogaesup database until the first bootstrap makes one.
    subprocess.run(['psql', '-h', args.endpoint, '-U', master['username'], '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
                   input="SELECT 'CREATE DATABASE mogaesup' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'mogaesup')\\gexec\n",
                   text=True, env=env, check=True, stdout=subprocess.DEVNULL)
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


def main():
    args = parse_args()
    ticket_secret = secret_value(args.ticket_secret, args.region)
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
    # An ordinary release finds the role as the first install left it and never reads the master secret.
    if not app_role_works(args.endpoint, database_env(root, password)):
        create_app_role(args, root, password)
    url = (f"postgres://mogaesup_app:{urllib.parse.quote(password, safe='')}@{args.endpoint}:5432/mogaesup"
           f"?sslmode=verify-full&sslrootcert={root}/global-bundle.pem")
    # The studio gateway and OpenAI settings come from the arguments given and, for the rest, from the file this run
    # replaces; the model store's sweep from that file.
    existing = read_env(config / 'server.env')
    sweep = model_sweep(existing)
    settings = factory_settings(existing, args, lambda: secret_value(args.factory_gateway_secret, args.region))
    openai, openai_note = openai_settings(existing, args, lambda: secret_value(args.openai_secret, args.region))
    lines = server_env_lines(args, url, ticket_secret, settings, sweep, openai)
    (config / 'server.env').write_text('\n'.join(lines) + '\n')
    (config / 'server.env').chmod(0o600)
    Path('/etc/systemd/system/mogaesup.service').write_text(SERVICE)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', 'mogaesup'], check=True)
    if not args.no_restart:
        subprocess.run(['systemctl', 'restart', 'mogaesup'], check=True)
    print('Application role and service installed. Credentials stay in root-readable configuration.')
    print(describe_factory(settings))
    print(f'Model sweep: {sweep}')
    print(describe_openai(openai, openai_note))


if __name__ == '__main__':
    main()
