import importlib.util
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from shell_harness import replace_host_paths

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
        existing = bootstrap.read_env(path)
        found = bootstrap.factory_settings(existing, args, lambda: ROTATED)
        return found, bootstrap.server_env_lines(args, 'postgres://app', 'ticket-secret', found,
                                                 bootstrap.model_sweep(existing))
    return build


def test_a_deploy_without_the_studio_flags_keeps_the_gateway_as_it_was(server_env):
    found, lines = server_env(EXISTING)
    assert lines[:9] == ['DATABASE_URL=postgres://app', 'LISTEN_ADDR=0.0.0.0:8080', 'APP_ORIGIN=https://mogaesup.com,https://www.mogaesup.com',
                         'COOKIE_SECURE=true', 'REALTIME_TICKET_SECRET=ticket-secret', 'MODEL_STORE=s3://bucket/models',
                         'MODEL_SWEEP=on', 'AWS_REGION=ap-northeast-2', 'RUST_LOG=info']
    assert lines[9:] == ['FACTORY_URL=https://studio.example.cloudfront.net', 'FACTORY_ACCESS=write', 'FACTORY_PAID_MONTHLY=20',
                         f'FACTORY_GATEWAY_KEY={GATEWAY_KEY}', f'STUDIO_INSTANCE_ID={INSTANCE}']


def test_production_sweeps_the_model_store_it_owns(server_env, bootstrap):
    # The site's bucket is this server's alone, so a server.env without the setting sweeps it. One an operator set (off,
    # after a sweep that took too much, say) stays through every deploy: earlier this rewrote it to on and the next
    # deploy deleted again. Empty is off, as the server reads it.
    for existing, sweep in ((None, 'on'), (EXISTING, 'on'), (EXISTING + 'MODEL_SWEEP=off\n', 'off'),
                            (EXISTING + 'MODEL_SWEEP=on\n', 'on'), (EXISTING + 'MODEL_SWEEP=\n', 'off'),
                            (EXISTING + 'MODEL_SWEEP="off"\n', 'off')):
        _, lines = server_env(existing)
        assert [line for line in lines if line.startswith('MODEL_SWEEP=')] == [f'MODEL_SWEEP={sweep}'], existing
    # A value the server refuses would stop it, and the previous release on the same file: nothing is installed.
    with pytest.raises(RuntimeError, match='MODEL_SWEEP'):
        bootstrap.model_sweep({'MODEL_SWEEP': 'yes'})


def test_the_deploy_log_names_the_model_sweep(bootstrap, deploy):
    source = Path(bootstrap.__file__).read_text(encoding='utf-8')
    assert "print(f'Model sweep: {sweep}')" in source
    assert "line.startswith(('Studio gateway:', 'Model sweep:', 'OpenAI:'))" in Path(deploy.__file__).read_text(
        encoding='utf-8')


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
    assert found == {} and len(lines) == 9


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
    assert list(found)[-2:] == ['FACTORY_OWNER_ID', 'FACTORY_API_KEY']
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
                    f'STUDIO_INSTANCE_ID={INSTANCE} FACTORY_GATEWAY_KEY=set FACTORY_JWT_SECRET=not set')
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


def test_the_running_release_serves_until_one_restart_after_the_bootstrap(deploy):
    lines = install_script(deploy)
    trap, configured, swapped, restarted, ok = (lines.index(text) for text in (
        'trap restore EXIT', 'configured=1', 'swapped=1', 'restarted=1', 'ok=1'))
    keep = next(index for index, line in enumerate(lines) if '.prev.new' in line and line.startswith('if'))
    bootstrap = next(index for index, line in enumerate(lines) if line.startswith('python3 bootstrap.py'))
    swap = next(index for index, line in enumerate(lines) if line.startswith('install -m 755 mogaesup-server'))
    restart = lines.index('systemctl restart mogaesup.service')
    assert trap < keep < configured < bootstrap < swapped < swap < restarted < restart
    assert restart < lines.index('systemctl is-active mogaesup') < ok
    # The bootstrap only writes the settings; nothing before the swap stops the service.
    assert lines[bootstrap].endswith(' --no-restart')
    assert not [line for line in lines[:swap] if line.startswith('systemctl stop') or line.startswith('systemctl restart')]
    # A failed copy of the previous binary must end the script, which `set -e` does not do inside an `&&` list.
    assert '&&' not in lines[keep]
    # What follows the healthy release is housekeeping that cannot fail the install.
    assert lines[ok + 1:] and all(line.endswith('|| true') for line in lines[ok + 1:])


def test_every_wait_on_the_instance_is_bounded(deploy):
    # SSM ends the script at its timeout without running the exit trap, so nothing may wait without a limit.
    for line in install_script(deploy):
        if 'curl ' in line:
            assert '--max-time' in line, line
    assert 'export PGCONNECT_TIMEOUT=10' in install_script(deploy)


def test_the_certificate_bundle_is_replaced_whole(deploy):
    lines = install_script(deploy)
    download = next(index for index, line in enumerate(lines) if 'global-bundle.pem' in line and line.startswith('curl'))
    assert lines[download].endswith('global-bundle.pem.new')
    assert lines[download + 1] == 'mv -f /opt/mogaesup/global-bundle.pem.new /opt/mogaesup/global-bundle.pem'
    # Before anything is stopped: a failed download leaves the running release alone.
    assert download < lines.index('swapped=1')


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
flock() { :; }
curl() {
  case "$*" in
    *127.0.0.1*) ;;
    *) while [ $# -gt 0 ]; do if [ "$1" = -o ]; then echo bundle > "$2"; fi; shift; done; return 0 ;;
  esac
  if [ -f "$SB/state/running" ] && grep -q GOOD "$SB/state/running"; then echo '{"status":"healthy"}'; return 0; fi
  return 22
}
python3() {
  echo "bootstrap $*" >> "$SB/calls.log"
  # It rewrites the settings (a failing one may have done so already) and leaves the restart to the install.
  echo rewritten > "$SB/etc/mogaesup/server.env"
  [ -z "${BOOTSTRAP_FAILS:-}" ] || return 1
  case " $* " in *' --no-restart '*) ;; *) systemctl restart mogaesup ;; esac
}
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


def install(deploy, bash, tmp_path, old='OLD-GOOD', new='NEW-GOOD', good=None, **faults):
    """Runs the install script on a fake instance under tmp_path: the binaries are text files, and one with GOOD in it
    answers its health check once the service is started. `good` is the last release that passed its health check."""
    sandbox = tmp_path.as_posix()
    if ' ' in sandbox:
        pytest.skip('the rendered script does not quote paths')
    for folder in ('state', 'var/log', 'var/lock', f'opt/mogaesup/releases/{RELEASE}', 'etc/mogaesup', 'etc/systemd/system'):
        (tmp_path / folder).mkdir(parents=True)
    (tmp_path / 'etc/mogaesup/server.env').write_text('ORIGINAL')
    (tmp_path / f'opt/mogaesup/releases/{RELEASE}/mogaesup-server').write_text(new)
    if old is not None:
        (tmp_path / 'opt/mogaesup/mogaesup-server').write_text(old)
        (tmp_path / 'state/running').write_text(old)
    if good is not None:
        (tmp_path / 'opt/mogaesup/mogaesup-server.good').write_text(good)
    script = replace_host_paths('\n'.join(install_script(deploy)), {
        '/opt/mogaesup': f'{sandbox}/opt/mogaesup', '/var/': f'{sandbox}/var/', '/etc/mogaesup': f'{sandbox}/etc/mogaesup',
        '/etc/systemd/system': f'{sandbox}/etc/systemd/system'})
    # Two tries of each health wait instead of thirty: starting a command costs far more here than the wait it stands for.
    script = script.replace('$(seq 1 30)', '$(seq 1 2)')
    done = subprocess.run([bash], input=(STUBS + script + '\n').encode(), capture_output=True, timeout=120, cwd=tmp_path,
                          env={**os.environ, 'SB': sandbox, **{name.upper(): '1' for name in faults}})

    def read(path):
        return (tmp_path / path).read_text() if (tmp_path / path).is_file() else ''
    return SimpleNamespace(code=done.returncode, err=done.stderr.decode(errors='replace'), binary=read('opt/mogaesup/mogaesup-server'),
                           prev=read('opt/mogaesup/mogaesup-server.prev'), good=read('opt/mogaesup/mogaesup-server.good'),
                           running=read('state/running'), stops=read('calls.log').count('systemctl stop'),
                           restarts=read('calls.log').count('systemctl restart'), env=read('etc/mogaesup/server.env'),
                           bootstrapped='bootstrap' in read('calls.log'), journal=read('var/log/mogaesup-failed-release.log'),
                           releases=sorted(path.name for path in (tmp_path / 'opt/mogaesup/releases').iterdir()))


def test_a_release_that_comes_up_replaces_the_binary_and_keeps_the_old_one(deploy, bash, tmp_path):
    done = install(deploy, bash, tmp_path)
    assert done.code == 0 and (done.binary, done.prev, done.running) == ('NEW-GOOD', 'OLD-GOOD', 'NEW-GOOD')
    assert done.good == 'NEW-GOOD' and done.env.strip() == 'rewritten'
    # One restart, after the bootstrap: the server is down only while it restarts.
    assert (done.stops, done.restarts) == (0, 1)


def test_a_failure_goes_back_to_the_last_release_that_answered(deploy, bash, tmp_path):
    # An install the SSM timeout cut short left an unchecked binary behind; the last healthy one comes back instead.
    done = install(deploy, bash, tmp_path, old='OLD-UNCHECKED-GOOD', good='OLD-GOOD', new='NEW-BAD')
    assert done.code != 0 and (done.binary, done.running) == ('OLD-GOOD', 'OLD-GOOD')
    assert done.prev == 'OLD-UNCHECKED-GOOD' and done.good == 'OLD-GOOD'


def test_the_service_log_of_a_failed_start_stays_on_the_instance(deploy, bash, tmp_path):
    # The command's output is printed in the pipeline's public log.
    done = install(deploy, bash, tmp_path, new='NEW-BAD')
    assert done.journal.strip() == 'journal tail' and 'journal tail' not in done.err
    assert '/var/log/mogaesup-failed-release.log' in done.err


def test_only_the_newest_release_folders_are_kept(deploy, bash, tmp_path):
    older = [f'release-2026090{day}T000000Z' for day in range(1, 8)]
    for at, name in enumerate(older):
        folder = tmp_path / 'opt/mogaesup/releases' / name
        folder.mkdir(parents=True)
        os.utime(folder, (1_700_000_000 + at, 1_700_000_000 + at))
    done = install(deploy, bash, tmp_path)
    assert done.code == 0 and done.releases == sorted([*older[-4:], RELEASE])


def test_a_release_that_never_gets_healthy_is_replaced_by_the_previous_binary(deploy, bash, tmp_path):
    done = install(deploy, bash, tmp_path, new='NEW-BAD')
    assert done.code != 0 and (done.binary, done.running) == ('OLD-GOOD', 'OLD-GOOD')
    assert 'starting the previous one again' in done.err and 'the previous release answers again' in done.err
    assert done.env == 'ORIGINAL'


def test_a_failing_bootstrap_leaves_the_running_release_untouched(deploy, bash, tmp_path):
    done = install(deploy, bash, tmp_path, bootstrap_fails=True)
    assert done.code != 0 and done.bootstrapped and (done.binary, done.running) == ('OLD-GOOD', 'OLD-GOOD')
    # Never stopped or restarted, and the settings it runs with are back on disk for its next start.
    assert (done.stops, done.restarts) == (0, 0) and done.env == 'ORIGINAL'


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


def cloudformation_calls(seen):
    return [call[1] for call in seen.aws if call[0] == 'cloudformation']


def test_without_yes_the_changes_are_listed_and_left_unapplied(deploy, cloudformation, capsys):
    cloudformation.changes = [{'ResourceChange': {'Action': 'Modify', 'LogicalResourceId': 'InstanceRole',
                                                  'ResourceType': 'AWS::IAM::Role', 'Replacement': 'False'}}]
    with pytest.raises(SystemExit) as stopped:
        deploy.provision(INSTANCE)
    assert str(stopped.value) == deploy.UNAPPLIED
    assert len(cloudformation.run) == 1 and '--no-execute-changeset' in cloudformation.run[0]
    assert f'StudioInstanceId={INSTANCE}' in cloudformation.run[0]
    assert 'InstanceRole (AWS::IAM::Role)' in capsys.readouterr().out
    assert cloudformation_calls(cloudformation) == ['describe-change-set', 'delete-change-set']


def test_the_stack_keeps_its_own_tags(deploy, cloudformation):
    # Tags the live stack does not have list every resource as modified, the instance as one that may be replaced.
    cloudformation.output = 'No changes to deploy. Stack mogaesup-server is up to date\n'
    deploy.provision()
    assert '--tags' not in cloudformation.run[0]


def test_without_yes_an_empty_change_set_goes_on(deploy, cloudformation):
    cloudformation.output = 'No changes to deploy. Stack mogaesup-server is up to date\n'
    deploy.provision()
    assert len(cloudformation.run) == 1 and cloudformation_calls(cloudformation) == []


def test_an_unreadable_answer_is_not_applied(deploy, cloudformation):
    cloudformation.output = 'something else\n'
    with pytest.raises(RuntimeError, match='change set could not be read'):
        deploy.provision(yes=True)
    assert len(cloudformation.run) == 1


def test_with_yes_the_listed_change_set_and_no_other_is_run(deploy, cloudformation, capsys):
    cloudformation.changes = [{'ResourceChange': {'Action': 'Modify', 'LogicalResourceId': 'InstanceRole',
                                                  'ResourceType': 'AWS::IAM::Role', 'Replacement': 'False'}}]
    deploy.provision(yes=True)
    assert '--no-execute-changeset' in cloudformation.run[0]
    assert 'InstanceRole (AWS::IAM::Role)' in capsys.readouterr().out
    executed = [call for call in cloudformation.aws if call[:2] == ('cloudformation', 'execute-change-set')]
    assert len(executed) == 1 and executed[0][-1] == ARN
    assert cloudformation.run[1][:4] == ['aws', 'cloudformation', 'wait', 'stack-update-complete']


@pytest.mark.parametrize('name, replacement', [('ApiInstance', 'True'), ('ApiInstance', 'Conditional'), ('Database', 'True')])
def test_yes_never_replaces_the_instance_or_the_database(deploy, cloudformation, name, replacement):
    cloudformation.changes = [{'ResourceChange': {'Action': 'Modify', 'LogicalResourceId': name,
                                                  'ResourceType': 'AWS::EC2::Instance', 'Replacement': replacement}}]
    with pytest.raises(SystemExit) as stopped:
        deploy.provision(yes=True)
    assert name in str(stopped.value) and 'nothing was applied' in str(stopped.value)
    assert cloudformation_calls(cloudformation) == ['describe-change-set', 'delete-change-set']


def test_a_database_newer_than_the_template_stops_the_change(deploy):
    assert deploy.template_engine_version() == '17.9'
    deploy.check_engine_version('17.9', '17.9')
    deploy.check_engine_version('17.6', '17.9')
    with pytest.raises(RuntimeError, match='raise EngineVersion'):
        deploy.check_engine_version('17.10', '17.9')


@pytest.mark.parametrize('name, action, replacement', [('ApiInstance', 'Remove', None), ('Database', 'Remove', None),
                                                       ('RealtimeTicketSecret', 'Remove', None)])
def test_yes_never_removes_a_kept_resource(deploy, cloudformation, name, action, replacement):
    # A logical id renamed in the template: the old resource goes (Remove) and a new one comes (Add).
    cloudformation.changes = [{'ResourceChange': {'Action': action, 'LogicalResourceId': name, 'ResourceType': 'X'}},
                              {'ResourceChange': {'Action': 'Add', 'LogicalResourceId': name + 'Renamed', 'ResourceType': 'X'}}]
    with pytest.raises(SystemExit) as stopped:
        deploy.provision(yes=True)
    assert name in str(stopped.value) and 'removes' in str(stopped.value)
    assert cloudformation_calls(cloudformation) == ['describe-change-set', 'delete-change-set']


def test_yes_may_remove_what_is_not_kept(deploy):
    description = {'Changes': [{'ResourceChange': {'Action': 'Remove', 'LogicalResourceId': 'DatabaseStorageAlarm'}},
                               {'ResourceChange': {'Action': 'Modify', 'LogicalResourceId': 'Database',
                                                   'Replacement': 'False'}}]}
    assert deploy.replacements(description) == []


def test_a_manual_release_must_be_committed_and_built_after_the_last_server_commit(deploy, monkeypatch, tmp_path):
    binary = tmp_path / 'mogaesup-server'
    binary.write_bytes(b'\x7fELF')
    answers = {'status': ' M server/src/main.rs\n', 'rev-parse': 'a' * 40 + '\n', 'log': '4000000000\n',
               'ls-remote': 'c' * 40 + '\trefs/heads/main\n'}

    def git(*args):
        return subprocess.CompletedProcess(args, 0, stdout=answers[args[0]], stderr='')
    monkeypatch.setattr(deploy, 'git', git)
    monkeypatch.setattr(deploy, 'pipeline_running', lambda: None)
    with pytest.raises(RuntimeError, match='Uncommitted server files'):
        deploy.release_commit(binary, environ={})
    answers['status'] = ''
    # Not main's newest: a commit not pushed yet, or one main has moved past (an ancestor is refused too).
    with pytest.raises(RuntimeError, match="not origin's main"):
        deploy.release_commit(binary, environ={})
    answers['ls-remote'] = ''
    with pytest.raises(RuntimeError, match="origin's main could not be read"):
        deploy.release_commit(binary, environ={})
    answers['ls-remote'] = 'a' * 40 + '\trefs/heads/main\n'
    with pytest.raises(RuntimeError, match='older than the last commit'):
        deploy.release_commit(binary, environ={})
    answers['log'] = '1000000000\n'
    assert deploy.release_commit(binary, environ={}) == 'a' * 40
    # The pipeline names the commit it checked out.
    assert deploy.release_commit(binary, environ={'GITHUB_ACTIONS': 'true', 'GITHUB_SHA': 'b' * 40}) == 'b' * 40


def test_a_pipeline_run_that_may_deploy_stops_a_manual_one_and_an_unknown_one_is_said(deploy, capsys):
    def gh(stdout, code=0):
        def run(command, **kwargs):
            assert command[:3] == ['gh', 'run', 'list'] and '--jq' not in command
            return subprocess.CompletedProcess(command, code, stdout=stdout, stderr='')
        return run
    deploy.pipeline_running(gh('[{"status": "completed"}, {"status": "completed"}]'))
    assert capsys.readouterr().out == ''
    for status in ('in_progress', 'queued', 'waiting', 'pending'):
        with pytest.raises(RuntimeError, match='queued or in progress'):
            deploy.pipeline_running(gh(f'[{{"status": "{status}"}}, {{"status": "completed"}}]'))

    def missing(command, **kwargs):
        raise FileNotFoundError('gh')
    for run in (missing, gh('', code=4), gh('not json')):
        deploy.pipeline_running(run)
        assert 'cannot be ruled out' in capsys.readouterr().out


def test_applying_the_stack_waits_for_a_pipeline_run_and_listing_it_does_not(deploy, monkeypatch):
    calls = []
    monkeypatch.setattr(deploy, 'aws', lambda *args: {'Account': deploy.ACCOUNT})
    monkeypatch.setattr(deploy, 'provision', lambda instance, yes: calls.append(('provision', yes)))

    def running(run=None, refusal=None):
        calls.append(('pipeline', refusal))
        raise RuntimeError(refusal)
    monkeypatch.setattr(deploy, 'pipeline_running', running)
    monkeypatch.delenv('GITHUB_ACTIONS', raising=False)
    monkeypatch.setattr(sys, 'argv', ['deploy-rust-server.py', '--provision-only', '--yes'])
    with pytest.raises(RuntimeError, match='before changing the stack'):
        deploy.main()
    assert calls == [('pipeline', deploy.STACK_REFUSAL)]
    calls.clear()
    # Listing the change set changes nothing, so it goes on.
    monkeypatch.setattr(sys, 'argv', ['deploy-rust-server.py', '--provision-only'])
    deploy.main()
    assert calls == [('provision', False)]


def test_the_stack_refusal_names_what_waits(deploy):
    def run(command, **kwargs):
        return subprocess.CompletedProcess(command, 0, stdout='[{"status": "in_progress"}]', stderr='')
    with pytest.raises(RuntimeError, match='before changing the stack'):
        deploy.pipeline_running(run, refusal=deploy.STACK_REFUSAL)


def test_where_cloudfront_sends_the_api_is_checked_before_anything_is_installed(deploy):
    source = Path(deploy.__file__).read_text(encoding='utf-8')
    main = source[source.index('def main():'):]
    assert main.index('check_web_origin(outputs)') < main.index("'s3', 'cp'") < main.index("'send-command'")
    assert main.count('check_web_origin(') == 1


def test_an_install_the_agent_does_not_take_in_time_expires_before_the_deploy_stops_waiting(deploy):
    # Without a delivery limit SSM keeps the install queued for an hour: one that starts after this deploy gave up on
    # it (an agent back online late) would install a release reported as failed, or over a newer one.
    source = Path(deploy.__file__).read_text(encoding='utf-8')
    main = source[source.index('def main():'):]
    send = main[main.index("'send-command'"):main.index("['Command']['CommandId']")]
    assert "'--timeout-seconds', str(DELIVERY_SECONDS)" in send
    assert 30 <= deploy.DELIVERY_SECONDS and deploy.DELIVERY_SECONDS + deploy.COMMAND_SECONDS <= deploy.COMMAND_WAIT


def test_cloudfront_must_send_the_api_to_this_stack(deploy, monkeypatch):
    outputs = {'VpcOriginId': 'vo_1', 'ApiPrivateDns': 'ip-10-0-0-1.ec2.internal'}

    def web(given):
        return lambda *args: {'Stacks': [{'Parameters': [{'ParameterKey': key, 'ParameterValue': value}
                                                         for key, value in given.items()]}]}
    monkeypatch.setattr(deploy, 'aws', web({'ApiVpcOriginId': 'vo_1', 'ApiPrivateDns': 'ip-10-0-0-1.ec2.internal'}))
    deploy.check_web_origin(outputs)
    monkeypatch.setattr(deploy, 'aws', web({'ApiVpcOriginId': 'vo_1', 'ApiPrivateDns': 'ip-10-0-0-9.ec2.internal'}))
    with pytest.raises(RuntimeError, match='ApiPrivateDns'):
        deploy.check_web_origin(outputs)


def test_the_gateway_token_settings_survive_a_deploy_and_stay_unprinted(server_env, bootstrap):
    found, lines = server_env(EXISTING + 'FACTORY_JWT_SECRET=jwt-secret-value-0123456789\nFACTORY_OWNER_ID=1\n')
    assert found['FACTORY_JWT_SECRET'] == 'jwt-secret-value-0123456789' and 'FACTORY_OWNER_ID=1' in lines
    assert list(found)[-2:] == ['FACTORY_JWT_SECRET', 'FACTORY_OWNER_ID']
    line = bootstrap.describe_factory(found)
    assert 'FACTORY_JWT_SECRET=set' in line and 'jwt-secret-value' not in line


# The OpenAI key: the server stack's OpenAiKeySecret holds a placeholder until the key is set by hand.

OPENAI_KEY = 'sk-proj-' + 'A1b2C3d4_e-' * 8
OPENAI_ARN = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:openai-AbCdEf'


@pytest.fixture
def openai_env(bootstrap, tmp_path):
    """The OpenAI part of server.env as the bootstrap writes it: from the file already on the instance and what the
    secret holds (`held`, or an exception when it cannot be read)."""
    def build(existing, held, *flags):
        path = tmp_path / 'server.env'
        path.write_text(existing)
        args = bootstrap.parse_args([*BASE, *flags])

        def fetch():
            if isinstance(held, Exception):
                raise held
            return held
        found, note = bootstrap.openai_settings(bootstrap.read_env(path), args, fetch)
        return found, note, bootstrap.server_env_lines(args, 'postgres://app', 'ticket-secret', {}, openai=found)
    return build


def test_the_openai_key_is_written_only_once_its_secret_holds_one(openai_env):
    found, note, lines = openai_env(EXISTING, OPENAI_KEY + '\n', '--openai-secret', OPENAI_ARN)
    assert lines[9:] == [f'OPENAI_API_KEY={OPENAI_KEY}'] and note == 'from the secret'
    # The placeholder, or anything that is no key (a second line would set another variable), writes none.
    for held in ('placeholder', 'placeholder\n', 'not a key', OPENAI_KEY + '\nCOOKIE_SECURE=false', 'sk-short', ''):
        found, note, lines = openai_env(EXISTING, held, '--openai-secret', OPENAI_ARN)
        assert found == {} and len(lines) == 9, held
        assert note in ('the secret holds the placeholder', 'the secret holds no key'), held


def test_the_secret_decides_when_it_is_named_and_the_file_otherwise(openai_env):
    had = EXISTING + f'OPENAI_API_KEY={OPENAI_KEY}\n'
    # Not named (a stack from before the secret), or not readable: the key the instance has stays.
    found, note, _ = openai_env(had, AssertionError('the secret was read'))
    assert found == {'OPENAI_API_KEY': OPENAI_KEY} and note == 'kept as server.env had it'
    unreadable = subprocess.CalledProcessError(255, ['aws'])
    found, note, _ = openai_env(had, unreadable, '--openai-secret', OPENAI_ARN)
    assert found == {'OPENAI_API_KEY': OPENAI_KEY} and note.startswith('the secret could not be read')
    # Named and holding the placeholder: none.
    assert openai_env(had, 'placeholder', '--openai-secret', OPENAI_ARN)[0] == {}
    rotated = OPENAI_KEY.replace('A1', 'Z9')
    assert openai_env(had, rotated, '--openai-secret', OPENAI_ARN)[0] == {'OPENAI_API_KEY': rotated}


def test_the_hand_set_openai_settings_stay_after_the_key(openai_env):
    had = (EXISTING + 'PICTURES_MONTHLY=50\nREADINGS_MONTHLY=600\nOPENAI_PICTURE_MODEL=gpt-image-2\n'
           'OPENAI_READING_EFFORT=low\nOPENAI_OTHER=x\n')
    found, _, lines = openai_env(had, OPENAI_KEY, '--openai-secret', OPENAI_ARN)
    assert list(found) == ['OPENAI_API_KEY', 'OPENAI_READING_EFFORT', 'OPENAI_PICTURE_MODEL', 'READINGS_MONTHLY',
                           'PICTURES_MONTHLY']
    assert lines[-4:] == ['OPENAI_READING_EFFORT=low', 'OPENAI_PICTURE_MODEL=gpt-image-2', 'READINGS_MONTHLY=600',
                          'PICTURES_MONTHLY=50']
    assert 'OPENAI_OTHER=x' not in lines


def test_the_openai_log_line_never_names_the_key(bootstrap, openai_env):
    found, note, _ = openai_env(EXISTING + 'READINGS_MONTHLY=600\n', OPENAI_KEY, '--openai-secret', OPENAI_ARN)
    line = bootstrap.describe_openai(found, note)
    assert line == 'OpenAI: OPENAI_API_KEY=set (from the secret) READINGS_MONTHLY=600'
    assert OPENAI_KEY not in line
    assert bootstrap.describe_openai({}, 'the secret holds the placeholder') == (
        'OpenAI: OPENAI_API_KEY=not set (the secret holds the placeholder)')


def test_the_deploy_names_the_openai_secret_the_stack_has(deploy, bootstrap):
    command = deploy.bootstrap_command(namespace(), {**OUTPUTS, 'OpenAiKeySecretArn': OPENAI_ARN}, INSTANCE)
    assert bootstrap.parse_args(command[2:]).openai_secret == OPENAI_ARN
    assert command[-2:] == ['--studio-instance-id', INSTANCE]
    # A stack from before the secret has no such output: the flag is left out and the instance keeps its key.
    assert '--openai-secret' not in deploy.bootstrap_command(namespace(), OUTPUTS, INSTANCE)
    assert 'OpenAiKeySecret' in deploy.KEEP


def test_the_stack_keeps_the_openai_key_out_of_the_template(deploy):
    template = (SCRIPTS.parent / 'infra' / 'aws-server.yaml').read_text(encoding='utf-8')
    secret = template.split('  OpenAiKeySecret:\n', 1)[1].split('\n  ', 1)[0]
    assert 'SecretString: placeholder' in template and 'sk-' not in template
    assert '- !Ref OpenAiKeySecret' in template and 'OpenAiKeySecretArn: {Value: !Ref OpenAiKeySecret}' in template
    assert secret.strip() == 'Type: AWS::SecretsManager::Secret'
