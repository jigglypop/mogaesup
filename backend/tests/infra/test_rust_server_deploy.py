import importlib.util
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / 'server' / 'scripts'
GATEWAY_KEY = 'gateway-key-from-the-secret-0123456789'
ROTATED = GATEWAY_KEY + '-rotated'
INSTANCE = 'i-0123456789abcdef0'
RELEASE = 'release-20261001T000000Z'
OUTPUTS = {'DatabaseSecretArn': 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:db-AbCdEf',
           'RealtimeTicketSecretArn': 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:ticket-AbCdEf',
           'DatabaseEndpoint': 'db.example.ap-northeast-2.rds.amazonaws.com',
           'FactoryGatewaySecretArn': 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:gate-AbCdEf'}
BASE = ['--secret', 's', '--ticket-secret', 't', '--endpoint', 'db', '--model-store', 's3://bucket/models',
        '--origin', 'https://mogaesup.com,https://www.mogaesup.com,https://mogaesup.com']
# What an earlier full deploy left on the instance.
EXISTING = f"""DATABASE_URL=postgres://old
LISTEN_ADDR=0.0.0.0:8080
FACTORY_URL=https://studio.example.cloudfront.net
FACTORY_ACCESS=write
FACTORY_PAID_MONTHLY=20
FACTORY_GATEWAY_KEY={GATEWAY_KEY}
STUDIO_INSTANCE_ID={INSTANCE}
RUST_LOG=info
"""


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), SCRIPTS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # both are guarded by __main__: importing runs nothing
    return module


@pytest.fixture(scope='module')
def bootstrap():
    return load('bootstrap-rust-server')


@pytest.fixture(scope='module')
def deploy():
    return load('deploy-rust-server')


@pytest.fixture
def server_env(bootstrap, tmp_path):
    """The part of the bootstrap that builds server.env: the file already on the instance plus the arguments given."""
    def build(existing, *flags):
        path = tmp_path / 'server.env'
        if existing is not None:
            path.write_text(existing)
        args = bootstrap.parse_args([*BASE, *flags])
        found = bootstrap.factory_settings(bootstrap.read_env(path), args, lambda: ROTATED)
        return found, bootstrap.server_env_lines(args, 'postgres://app', 'ticket-secret', found)
    return build


def test_a_deploy_without_the_studio_flags_keeps_the_gateway_as_it_was(server_env):
    found, lines = server_env(EXISTING)
    assert lines[:8] == ['DATABASE_URL=postgres://app', 'LISTEN_ADDR=0.0.0.0:8080', 'APP_ORIGIN=https://mogaesup.com,https://www.mogaesup.com',
                         'COOKIE_SECURE=true', 'REALTIME_TICKET_SECRET=ticket-secret', 'MODEL_STORE=s3://bucket/models',
                         'AWS_REGION=ap-northeast-2', 'RUST_LOG=info']
    assert lines[8:] == ['FACTORY_URL=https://studio.example.cloudfront.net', 'FACTORY_ACCESS=write', 'FACTORY_PAID_MONTHLY=20',
                         f'FACTORY_GATEWAY_KEY={GATEWAY_KEY}', f'STUDIO_INSTANCE_ID={INSTANCE}']


def test_the_gateway_key_is_refreshed_from_its_secret_when_one_is_named(server_env):
    found, _ = server_env(EXISTING, '--factory-gateway-secret', 'arn:gate')
    assert found['FACTORY_GATEWAY_KEY'] == ROTATED
    assert list(found) == ['FACTORY_URL', 'FACTORY_ACCESS', 'FACTORY_PAID_MONTHLY', 'FACTORY_GATEWAY_KEY', 'STUDIO_INSTANCE_ID']


def test_flags_that_are_given_win_over_the_file(server_env):
    found, _ = server_env(EXISTING, '--factory-access', 'read', '--factory-paid-monthly', '0', '--factory-url', 'https://other.example',
                          '--studio-instance-id', 'i-0fedcba9876543210')
    assert found['FACTORY_URL'] == 'https://other.example' and found['FACTORY_ACCESS'] == 'read'
    assert found['FACTORY_PAID_MONTHLY'] == '0' and found['STUDIO_INSTANCE_ID'] == 'i-0fedcba9876543210'


def test_an_empty_studio_instance_removes_only_that(server_env):
    found, lines = server_env(EXISTING, '--studio-instance-id', '')
    assert 'STUDIO_INSTANCE_ID' not in found and found['FACTORY_ACCESS'] == 'write'
    assert not [line for line in lines if line.startswith('STUDIO_INSTANCE_ID')]


def test_an_empty_factory_url_switches_the_gateway_off(server_env):
    found, lines = server_env(EXISTING, '--factory-url', '')
    assert found == {} and len(lines) == 8


def test_a_first_deploy_with_a_url_gets_the_defaults(server_env):
    found, _ = server_env(None, '--factory-url', 'https://studio.example', '--factory-gateway-secret', 'arn:gate')
    assert found == {'FACTORY_URL': 'https://studio.example', 'FACTORY_ACCESS': 'read', 'FACTORY_PAID_MONTHLY': '0',
                     'FACTORY_GATEWAY_KEY': ROTATED}


def test_the_gateway_secret_is_not_read_for_a_server_without_a_character_server(bootstrap):
    def refuse():
        raise AssertionError('the secret was fetched')
    assert bootstrap.factory_settings({}, bootstrap.parse_args([*BASE, '--factory-gateway-secret', 'arn:gate']), refuse) == {}


def test_other_factory_entries_stay_after_the_ones_the_deploy_manages(server_env):
    found, lines = server_env(EXISTING + 'FACTORY_API_KEY=abc\nFACTORY_OWNER_ID=7\nSOMETHING_ELSE=1\n')
    assert list(found)[-2:] == ['FACTORY_API_KEY', 'FACTORY_OWNER_ID']
    assert 'FACTORY_API_KEY=abc' in lines and 'SOMETHING_ELSE=1' not in lines


def test_the_env_file_is_read_like_systemd_does(bootstrap, tmp_path):
    path = tmp_path / 'server.env'
    path.write_text('# comment\n\nA=1\n B = two \nC="quoted value"\nD=\'single\'\nE=with=equals\n;ignored=1\nno-separator\n')
    assert bootstrap.read_env(path) == {'A': '1', 'B': 'two', 'C': 'quoted value', 'D': 'single', 'E': 'with=equals'}
    assert bootstrap.read_env(tmp_path / 'missing.env') == {}


def test_the_log_line_names_the_settings_and_never_a_secret(bootstrap):
    found = bootstrap.factory_settings(
        {'FACTORY_URL': 'https://studio.example', 'FACTORY_ACCESS': 'paid', 'FACTORY_PAID_MONTHLY': '5',
         'FACTORY_GATEWAY_KEY': GATEWAY_KEY, 'FACTORY_API_KEY': 'api-key-value', 'STUDIO_INSTANCE_ID': INSTANCE},
        bootstrap.parse_args(BASE), lambda: '')
    line = bootstrap.describe_factory(found)
    assert line == ('Studio gateway: FACTORY_URL=https://studio.example FACTORY_ACCESS=paid FACTORY_PAID_MONTHLY=5 '
                    f'STUDIO_INSTANCE_ID={INSTANCE} FACTORY_GATEWAY_KEY=set')
    assert GATEWAY_KEY not in line and 'api-key-value' not in line
    assert bootstrap.describe_factory({}) == 'Studio gateway: off (server.env has no FACTORY_URL)'
    assert 'STUDIO_INSTANCE_ID=(none)' in bootstrap.describe_factory({'FACTORY_URL': 'https://x.example'})


def namespace(**given):
    return SimpleNamespace(**{'origin': 'https://mogaesup.com', 'model_store': 's3://bucket/models', 'factory_url': None,
                              'factory_access': None, 'factory_paid_monthly': None, **given})


def test_the_deploy_does_not_default_the_studio_flags(deploy):
    args = deploy.parse_args([])
    assert (args.factory_url, args.factory_access, args.factory_paid_monthly, args.studio_instance_id, args.yes) == (None,) * 4 + (False,)
    assert deploy.parse_args(['--yes', '--factory-access', 'write']).factory_access == 'write'


def test_the_deploy_leaves_out_the_studio_flags_it_was_not_given(deploy, bootstrap):
    command = deploy.bootstrap_command(namespace(), OUTPUTS, '')
    assert command[:2] == ['python3', 'bootstrap.py']
    assert not [flag for flag in command if flag in ('--factory-url', '--factory-access', '--factory-paid-monthly')]
    # The stack's own studio instance and the gateway secret always go along; the instance is empty when the stack names none.
    assert command[-2:] == ['--studio-instance-id', ''] and '--factory-gateway-secret' in command
    parsed = bootstrap.parse_args(command[2:])
    assert (parsed.factory_url, parsed.factory_access, parsed.factory_paid_monthly, parsed.studio_instance_id) == (None, None, None, '')


def test_the_deploy_passes_the_studio_flags_it_was_given(deploy, bootstrap):
    given = namespace(factory_url='https://studio.example', factory_access='write', factory_paid_monthly=0)
    parsed = bootstrap.parse_args(deploy.bootstrap_command(given, OUTPUTS, INSTANCE)[2:])
    assert (parsed.factory_url, parsed.factory_access, parsed.factory_paid_monthly) == ('https://studio.example', 'write', 0)
    assert parsed.studio_instance_id == INSTANCE and parsed.factory_gateway_secret == OUTPUTS['FactoryGatewaySecretArn']
    assert bootstrap.parse_args(deploy.bootstrap_command(namespace(factory_url=''), OUTPUTS, '')[2:]).factory_url == ''


# The script SSM runs on the instance to install a release.

def install_script(deploy):
    return deploy.install_commands(RELEASE, 'bucket-x', deploy.bootstrap_command(namespace(), OUTPUTS, INSTANCE))


def test_the_install_script_is_valid_bash(deploy, bash):
    done = subprocess.run([bash, '-n'], input=('\n'.join(install_script(deploy)) + '\n').encode(), capture_output=True, timeout=60)
    assert done.returncode == 0, done.stderr.decode(errors='replace')


def test_the_previous_binary_is_kept_before_the_swap_and_restored_after_a_failure(deploy):
    lines = install_script(deploy)
    trap, stopped, swapped, ok = (lines.index(text) for text in ('trap restore EXIT', 'stopped=1', 'swapped=1', 'ok=1'))
    stop = lines.index('systemctl stop mogaesup.service 2>/dev/null || true', stopped)
    keep = next(index for index, line in enumerate(lines) if '.prev.new' in line and line.startswith('if'))
    swap = next(index for index, line in enumerate(lines) if line.startswith('install -m 755 mogaesup-server'))
    bootstrap = next(index for index, line in enumerate(lines) if line.startswith('python3 bootstrap.py'))
    assert trap < stopped < stop < keep < swapped < swap < bootstrap < lines.index('systemctl is-active mogaesup') < ok == len(lines) - 1
    # A failed copy of the previous binary must end the script, which `set -e` does not do inside an `&&` list.
    assert '&&' not in lines[keep]


# The commands the script runs on the instance, as bash functions (a function beats the command of the same name).
STUBS = '''
systemctl() {
  echo "systemctl $*" >> "$SB/calls.log"
  case "$1" in
    stop) rm -f "$SB/state/running" ;;
    restart) cp "$SB/opt/mogaesup/mogaesup-server" "$SB/state/running" ;;
    is-active) if [ -f "$SB/state/running" ]; then echo active; else echo inactive; return 3; fi ;;
  esac
}
curl() {
  case "$*" in *127.0.0.1*) ;; *) return 0 ;; esac
  if [ -f "$SB/state/running" ] && grep -q GOOD "$SB/state/running"; then echo '{"status":"healthy"}'; return 0; fi
  return 22
}
python3() { echo bootstrap >> "$SB/calls.log"; [ -z "${BOOTSTRAP_FAILS:-}" ] || return 1; systemctl restart mogaesup; }
install() {
  if [ "$1" = -d ]; then shift; while [ $# -gt 0 ]; do case "$1" in -m|-o|-g) shift 2;; *) mkdir -p "$1"; shift;; esac; done; return 0; fi
  args=(); while [ $# -gt 0 ]; do case "$1" in -m|-o|-g) shift 2;; *) args+=("$1"); shift;; esac; done
  cp "${args[0]}" "${args[1]}"
}
cp() {
  if [ -n "${CP_FAILS:-}" ] && [[ "$*" == *prev.new* ]]; then echo "cp: disk full" >&2; return 1; fi
  command -p cp "$@"
}
sha256sum() { [ -z "${SHA_FAILS:-}" ] || { echo "SHA256SUMS: FAILED" >&2; return 1; }; }
journalctl() { echo "journal tail"; }
dnf() { :; }; aws() { :; }; chown() { :; }; chmod() { :; }; sleep() { :; }
'''


def install(deploy, bash, tmp_path, old='OLD-GOOD', new='NEW-GOOD', **faults):
    """Runs the install script on a fake instance under tmp_path: the binaries are text files, and one with GOOD in it
    answers its health check once the service is started."""
    sandbox = tmp_path.as_posix()
    if ' ' in sandbox:
        pytest.skip('the rendered script does not quote paths')
    for folder in ('state', 'var/log', f'opt/mogaesup/releases/{RELEASE}'):
        (tmp_path / folder).mkdir(parents=True)
    (tmp_path / f'opt/mogaesup/releases/{RELEASE}/mogaesup-server').write_text(new)
    if old is not None:
        (tmp_path / 'opt/mogaesup/mogaesup-server').write_text(old)
        (tmp_path / 'state/running').write_text(old)
    script = '\n'.join(install_script(deploy)).replace('/opt/mogaesup', f'{sandbox}/opt/mogaesup').replace('/var/', f'{sandbox}/var/')
    # Two tries of each health wait instead of thirty: starting a command costs far more here than the wait it stands for.
    script = script.replace('$(seq 1 30)', '$(seq 1 2)')
    done = subprocess.run([bash], input=(STUBS + script + '\n').encode(), capture_output=True, timeout=120, cwd=tmp_path,
                          env={**os.environ, 'SB': sandbox, **{name.upper(): '1' for name in faults}})

    def read(path):
        return (tmp_path / path).read_text() if (tmp_path / path).is_file() else ''
    return SimpleNamespace(code=done.returncode, err=done.stderr.decode(errors='replace'), binary=read('opt/mogaesup/mogaesup-server'),
                           prev=read('opt/mogaesup/mogaesup-server.prev'), running=read('state/running'),
                           stops=read('calls.log').count('systemctl stop'), bootstrapped='bootstrap' in read('calls.log'))


def test_a_release_that_comes_up_replaces_the_binary_and_keeps_the_old_one(deploy, bash, tmp_path):
    done = install(deploy, bash, tmp_path)
    assert done.code == 0 and (done.binary, done.prev, done.running) == ('NEW-GOOD', 'OLD-GOOD', 'NEW-GOOD')


def test_a_release_that_never_gets_healthy_is_replaced_by_the_previous_binary(deploy, bash, tmp_path):
    done = install(deploy, bash, tmp_path, new='NEW-BAD')
    assert done.code != 0 and (done.binary, done.running) == ('OLD-GOOD', 'OLD-GOOD')
    assert 'starting the previous one again' in done.err and 'the previous release answers again' in done.err


def test_a_failing_bootstrap_puts_the_previous_binary_back_too(deploy, bash, tmp_path):
    done = install(deploy, bash, tmp_path, bootstrap_fails=True)
    assert done.code != 0 and done.bootstrapped and (done.binary, done.running) == ('OLD-GOOD', 'OLD-GOOD')


def test_a_failed_copy_of_the_previous_binary_stops_before_the_swap(deploy, bash, tmp_path):
    done = install(deploy, bash, tmp_path, cp_fails=True)
    assert done.code != 0 and not done.bootstrapped
    assert (done.binary, done.prev, done.running) == ('OLD-GOOD', '', 'OLD-GOOD')


def test_a_first_release_that_fails_has_nothing_to_go_back_to(deploy, bash, tmp_path):
    done = install(deploy, bash, tmp_path, old=None, new='NEW-BAD')
    assert done.code != 0 and done.prev == '' and 'there is no previous binary to put back' in done.err


def test_a_bad_checksum_leaves_the_running_service_alone(deploy, bash, tmp_path):
    done = install(deploy, bash, tmp_path, sha_fails=True)
    assert done.code != 0 and done.stops == 0 and (done.binary, done.running) == ('OLD-GOOD', 'OLD-GOOD')


# Infrastructure changes are listed, and applied only with --yes.

ARN = ('arn:aws:cloudformation:ap-northeast-2:960243570517:changeSet/awscli-cloudformation-package-deploy-1790000000/'
       '5d6a3c1e-0000-4000-8000-000000000000')
CREATED = ('Waiting for changeset to be created..\n\nChangeset created successfully. Run the following command to review changes:\n'
           f'aws cloudformation describe-change-set --change-set-name {ARN}\n')


def test_the_change_set_is_found_in_the_deploy_output(deploy):
    assert deploy.change_set_arn(CREATED) == ARN
    assert deploy.change_set_arn('No changes to deploy. Stack mogaesup-server is up to date\n') is None


def test_the_change_list_calls_out_replacements(deploy):
    def change(action, name, kind, replacement=None):
        return {'Type': 'Resource', 'ResourceChange': {'Action': action, 'LogicalResourceId': name, 'ResourceType': kind,
                                                       **({'Replacement': replacement} if replacement else {})}}
    lines = deploy.change_lines({'Changes': [change('Modify', 'ApiInstance', 'AWS::EC2::Instance', 'True'),
                                             change('Modify', 'InstanceRole', 'AWS::IAM::Role', 'False'),
                                             change('Add', 'Extra', 'AWS::SQS::Queue'),
                                             change('Modify', 'Sg', 'AWS::EC2::SecurityGroup', 'Conditional')]})
    assert lines == ['Modify  ApiInstance (AWS::EC2::Instance)  REPLACES the resource',
                     'Modify  InstanceRole (AWS::IAM::Role)', 'Add     Extra (AWS::SQS::Queue)',
                     'Modify  Sg (AWS::EC2::SecurityGroup)  may replace the resource']
    assert deploy.change_lines({}) == []


@pytest.fixture
def cloudformation(deploy, monkeypatch):
    """provision() with the aws CLI faked: `output` is what `cloudformation deploy` prints."""
    seen = SimpleNamespace(run=[], aws=[], output=CREATED, changes=[])

    def run(command, **kwargs):
        seen.run.append(command)
        return subprocess.CompletedProcess(command, 0, stdout=seen.output, stderr='')

    def aws(*args):
        seen.aws.append(args)
        return {'Changes': seen.changes} if args[1] == 'describe-change-set' else {}
    monkeypatch.setattr(deploy, 'subprocess', SimpleNamespace(run=run))
    monkeypatch.setattr(deploy, 'aws', aws)
    monkeypatch.setattr(deploy, 'service_group', lambda: None)
    return seen


def test_without_yes_the_changes_are_listed_and_left_unapplied(deploy, cloudformation, capsys):
    cloudformation.changes = [{'ResourceChange': {'Action': 'Modify', 'LogicalResourceId': 'ApiInstance',
                                                  'ResourceType': 'AWS::EC2::Instance', 'Replacement': 'True'}}]
    with pytest.raises(SystemExit) as stopped:
        deploy.provision(INSTANCE)
    assert str(stopped.value) == deploy.UNAPPLIED
    assert len(cloudformation.run) == 1 and '--no-execute-changeset' in cloudformation.run[0]
    assert f'StudioInstanceId={INSTANCE}' in cloudformation.run[0]
    assert 'ApiInstance (AWS::EC2::Instance)  REPLACES the resource' in capsys.readouterr().out
    assert [call[1] for call in cloudformation.aws] == ['describe-change-set', 'delete-change-set']


def test_without_yes_an_empty_change_set_goes_on(deploy, cloudformation):
    cloudformation.output = 'No changes to deploy. Stack mogaesup-server is up to date\n'
    deploy.provision()
    assert len(cloudformation.run) == 1 and cloudformation.aws == []


def test_without_yes_an_unreadable_answer_is_not_applied(deploy, cloudformation):
    cloudformation.output = 'something else\n'
    with pytest.raises(RuntimeError, match='--yes'):
        deploy.provision()


def test_with_yes_the_stack_is_deployed_as_before(deploy, cloudformation):
    deploy.provision(yes=True)
    assert len(cloudformation.run) == 1 and '--no-execute-changeset' not in cloudformation.run[0]
    assert cloudformation.run[0][:4] == ['aws', 'cloudformation', 'deploy', '--region'] and cloudformation.aws == []
