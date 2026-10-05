#!/usr/bin/env python3
"""Deploys the verified Linux release binary to the mogaesup-server stack through private S3 and SSM.

Uses the existing AWS CLI credentials only and never brings a secret to the developer machine.
Build first: see README "배포". Usage: python scripts/deploy-rust-server.py [--skip-provision] [--yes] [--factory-url URL]
[--factory-access read|write|paid] [--factory-paid-monthly N] [--studio-instance-id i-…]
Infrastructure changes are listed and left unapplied until --yes, which runs that listed change set, never one that
replaces the instance or the database. The studio gateway flags are optional: one left out keeps the value
/etc/mogaesup/server.env already has, and the setting the server ended with is printed at the end. Run by hand, it refuses
uncommitted server files, a binary older than the last server commit, and a pipeline run in progress on main; the commit
goes with the release (/opt/mogaesup/current-release.json on the instance).
"""
import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGION = 'ap-northeast-2'
ACCOUNT = '960243570517'
STACK = 'mogaesup-server'
VPC = 'vpc-01dc516a'
SUBNETS = ('subnet-4a9f2021', 'subnet-436a0238')
SERVICE_GROUP = 'CloudFront-VPCOrigins-Service-SG'
# The AL2023 image the instance runs; changing it replaces the instance (new private DNS for the web stack).
IMAGE = 'ami-03137ee2d0c5af1fe'
CHANGE_SET = re.compile(r'arn:aws[a-z-]*:cloudformation:\S+:changeSet/\S+')
UNAPPLIED = 'Infrastructure changes are listed above and not applied; run again with --yes to apply them'
DATABASE = 'mogaesup-postgres'
# Resources whose replacement --yes never applies.
KEEP = ('ApiInstance', 'Database', 'RuntimeBucket', 'VpcOrigin', 'RealtimeTicketSecret', 'FactoryGatewaySecret',
        'CharacterDatabaseSecret', 'ApiSecurityGroup')
WEB_STACK = 'mogaesup-web'
# The release paths the server deploy ships (.github/scripts/release_parts.sh); a manual deploy refuses changes there.
RELEASE_PATHS = ('server',)
# What the bootstrap rewrites on the instance; kept as <file>.prev before it runs, and put back with the binary.
SERVER_ENV = '/etc/mogaesup/server.env'
SERVICE_UNIT = '/etc/systemd/system/mogaesup.service'
# The SSM command's own limit (executionTimeout), and how long its invocation is waited for past it.
COMMAND_SECONDS = 900
COMMAND_WAIT = COMMAND_SECONDS + 120


def aws(*args):
    process = subprocess.run(['aws', *args, '--no-cli-pager', '--output', 'json'], capture_output=True)
    # AWS CLI on Windows may encode embedded SSM logs in the console codepage.
    stdout = process.stdout.decode('utf-8', errors='replace')
    stderr = process.stderr.decode('utf-8', errors='replace')
    if process.returncode:
        raise RuntimeError(f'AWS {args[0]} {args[1]} failed: {stderr.strip()}')
    return json.loads(stdout) if stdout.strip() else {}


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def service_group():
    """CloudFront creates this group with the first VPC origin in the VPC; until then the origin prefix list stands in."""
    groups = aws('ec2', 'describe-security-groups', '--region', REGION, '--filters', f'Name=vpc-id,Values={VPC}',
                 f'Name=group-name,Values={SERVICE_GROUP}')['SecurityGroups']
    return groups[0]['GroupId'] if len(groups) == 1 else None


def change_set_arn(output):
    """The change set that `aws cloudformation deploy --no-execute-changeset` names in its output, or None."""
    found = CHANGE_SET.search(output)
    return found.group(0) if found else None


def change_lines(description):
    """One line per resource change of `describe-change-set`, a replacement called out, then a line for what of it
    changes (its scope) and one per changed attribute or property, with whether that change replaces the resource."""
    lines = []
    for change in description.get('Changes', []):
        resource = change.get('ResourceChange', {})
        replacement = {'True': '  REPLACES the resource', 'Conditional': '  may replace the resource'}.get(
            resource.get('Replacement'), '')
        lines.append(f"{resource.get('Action', '?'):<8}{resource.get('LogicalResourceId', '?')} "
                     f"({resource.get('ResourceType', '?')}){replacement}")
        if resource.get('Scope'):
            lines.append(f"        scope: {', '.join(resource['Scope'])}")
        for detail in resource.get('Details', []):
            target = detail.get('Target', {})
            name = '.'.join(part for part in (target.get('Attribute'), target.get('Name')) if part) or '?'
            recreation = {'Always': '  requires replacement', 'Conditionally': '  may require replacement'}.get(
                target.get('RequiresRecreation'), '')
            source = f" ({detail['ChangeSource']})" if detail.get('ChangeSource') else ''
            lines.append(f'        {name}{source}{recreation}')
    return lines


def stack_settled(status):
    """Whether the stack can be deployed onto now (True), is still changing (False), or failed (RuntimeError). A
    rolled-back update leaves the stack as it was before that update, which a release can go onto."""
    if status in ('CREATE_COMPLETE', 'UPDATE_COMPLETE'):
        return True
    if status == 'UPDATE_ROLLBACK_COMPLETE':
        print('Warning: the last stack update was rolled back (UPDATE_ROLLBACK_COMPLETE); deploying onto the stack as '
              'it stands', flush=True)
        return True
    if status.endswith('_IN_PROGRESS'):
        return False
    raise RuntimeError(status)


def wait_for_command(command, instance, deadline_seconds=COMMAND_WAIT, interval=10, sleep=time.sleep,
                     clock=time.monotonic):
    """The finished invocation of an SSM command. A failed lookup (the invocation not registered yet, a throttled call)
    is asked again until the deadline instead of ending the deploy while the install goes on."""
    deadline = clock() + deadline_seconds
    failure = None
    while True:
        try:
            result = aws('ssm', 'get-command-invocation', '--region', REGION, '--command-id', command,
                         '--instance-id', instance)
            failure = None
            if result['Status'] not in ('Pending', 'InProgress', 'Delayed'):
                return result
        except RuntimeError as error:
            failure = error
        if clock() > deadline:
            raise RuntimeError(f'SSM command {command} did not finish within {deadline_seconds} s'
                               + (f'; the last lookup failed: {failure}' if failure else ''))
        print('Installing the verified release via SSM', flush=True)
        sleep(interval)


def replacements(description):
    """The resources a change set replaces or may replace whose loss takes the site down or its data away."""
    return [change['ResourceChange']['LogicalResourceId'] for change in description.get('Changes', [])
            if change.get('ResourceChange', {}).get('LogicalResourceId') in KEEP
            and change['ResourceChange'].get('Replacement') in ('True', 'Conditional')]


def template_engine_version(text=None):
    text = text if text is not None else (ROOT / 'infra/aws-server.yaml').read_text(encoding='utf-8')
    found = re.search(r"^\s+EngineVersion: '([0-9.]+)'", text, re.M)
    return found.group(1) if found else None


def check_engine_version(live, template):
    """RDS refuses a stack change that names a version below the one the instance runs (a downgrade)."""
    def parts(version):
        return tuple(int(part) for part in version.split('.'))
    if live and template and parts(live) > parts(template):
        raise RuntimeError(f"The database runs PostgreSQL {live}, above the template's EngineVersion {template}: raise "
                           'EngineVersion in server/infra/aws-server.yaml to it before changing the stack')


def provision(studio_instance=None, yes=False):
    group = service_group()
    overrides = [f'VpcId={VPC}', f'SubnetA={SUBNETS[0]}', f'SubnetB={SUBNETS[1]}', f'ImageId={IMAGE}']
    if group:
        overrides.append(f'CloudFrontServiceGroup={group}')
    # Left out, the stack keeps the instance it was given before.
    if studio_instance is not None:
        overrides.append(f'StudioInstanceId={studio_instance}')
    try:
        found = aws('rds', 'describe-db-instances', '--region', REGION, '--db-instance-identifier', DATABASE)
        check_engine_version(found['DBInstances'][0]['EngineVersion'], template_engine_version())
    except (RuntimeError, KeyError, IndexError) as error:
        if 'EngineVersion' in str(error):
            raise
        print(f'Warning: the version of {DATABASE} could not be compared with the template ({error})', flush=True)
    # No --tags: the stack keeps the tags it has. Tags that differ from the live stack's would list every resource as
    # modified, and the instance as one that may be replaced, in every change set.
    deploy = ['aws', 'cloudformation', 'deploy', '--region', REGION, '--stack-name', STACK,
              '--template-file', str(ROOT / 'infra/aws-server.yaml'), '--parameter-overrides', *overrides,
              '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset', '--no-execute-changeset']
    # The change set is made, listed, and with --yes run: that change set and no other.
    process = subprocess.run(deploy, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if process.returncode:
        raise RuntimeError(f'aws cloudformation deploy failed: {process.stderr.strip()}')
    arn = change_set_arn(process.stdout + process.stderr)
    if arn is None:
        if 'No changes to deploy' in process.stdout:
            return
        raise RuntimeError('The change set could not be read from the aws output; inspect the stack in the console')
    description = aws('cloudformation', 'describe-change-set', '--region', REGION, '--change-set-name', arn)
    for line in change_lines(description):
        print(line, flush=True)
    replaced = replacements(description)
    if yes and not replaced:
        aws('cloudformation', 'execute-change-set', '--region', REGION, '--change-set-name', arn)
        subprocess.run(['aws', 'cloudformation', 'wait', 'stack-update-complete', '--region', REGION, '--stack-name', STACK],
                       check=True)
        return
    try:
        aws('cloudformation', 'delete-change-set', '--region', REGION, '--change-set-name', arn)
    except RuntimeError:
        pass
    if replaced:
        raise SystemExit(f"The change set replaces or may replace {', '.join(replaced)}; nothing was applied. A new "
                         'instance has a new private DNS name (the web stack points at it) and a new database starts '
                         'empty: change the stack by hand after reading the change set')
    raise SystemExit(UNAPPLIED)


def bootstrap_command(args, outputs, studio_instance):
    """The bootstrap.py command line. A studio gateway flag the operator did not give is left out, so the instance keeps the
    value it has; the studio instance is always the stack's (empty when it names none), since its role may start only that."""
    command = ['python3', 'bootstrap.py', '--secret', outputs['DatabaseSecretArn'],
               '--ticket-secret', outputs['RealtimeTicketSecretArn'], '--endpoint', outputs['DatabaseEndpoint'],
               '--origin', args.origin, '--model-store', args.model_store]
    for flag, value in (('--factory-url', args.factory_url), ('--factory-access', args.factory_access),
                        ('--factory-paid-monthly', args.factory_paid_monthly)):
        if value is not None:
            command += [flag, str(value)]
    if outputs.get('FactoryGatewaySecretArn'):
        command += ['--factory-gateway-secret', outputs['FactoryGatewaySecretArn']]
    return [*command, '--studio-instance-id', studio_instance]


def install_commands(release, bucket, bootstrap):
    """The SSM script lines that install a release. Everything that takes time happens while the running release keeps
    serving: the download and its checksums, the RDS certificates, and the bootstrap (database role, server.env, the
    systemd unit; it does not restart). Then the binary is swapped and the service restarted once, so the server is down
    only for that restart. The binary being replaced is kept as mogaesup-server.prev, and the server.env and systemd unit
    the bootstrap rewrites as <file>.prev. Any failure before a healthy new release (the exit trap) puts those back and,
    once the binary was swapped, starts the previous release again: the last release that answered its health check
    (mogaesup-server.good), or the binary it replaced when none has yet."""
    folder = f'/opt/mogaesup/releases/{release}'
    binary = '/opt/mogaesup/mogaesup-server'
    bundle = '/opt/mogaesup/global-bundle.pem'
    # Every wait is bounded: SSM ends the script at its execution timeout without running the exit trap.
    health = 'curl -fsS --max-time 5 http://127.0.0.1:8080/api/health'
    return [
        'set -eu',
        # One install at a time; a second one would take the first one's binary as the previous release.
        'exec 9>/var/lock/mogaesup-install.lock', "flock -n 9 || { echo 'another install is running' >&2; exit 3; }",
        'dnf install -y postgresql17 > /var/log/mogaesup-packages.log',
        f'install -d -m 750 {folder}',
        f'aws s3 cp s3://{bucket}/{release}/ {folder}/ --region {REGION} --recursive --no-progress --only-show-errors '
        '--cli-connect-timeout 10 --cli-read-timeout 60',
        f'cd {folder}', 'sha256sum -c SHA256SUMS',
        # The running server reads the RDS certificates from this file: it is replaced whole or not at all.
        f'curl --fail --silent --show-error --max-time 60 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o {bundle}.new',
        f'mv -f {bundle}.new {bundle}',
        'export PGCONNECT_TIMEOUT=10',
        'restarted=0; swapped=0; configured=0; ok=0',
        'restore() {',
        '  status=$?; trap - EXIT',
        '  if [ "$ok" != 1 ] && { [ "$configured" = 1 ] || [ "$swapped" = 1 ]; }; then',
        '    [ "$status" != 0 ] || status=1',
        '    if [ "$swapped" = 1 ]; then',
        "      echo 'the new release did not come up; starting the previous one again' >&2",
        # The service's own log stays on the instance: the command's output reaches the pipeline's public log.
        '      journalctl -u mogaesup -n 40 --no-pager > /var/log/mogaesup-failed-release.log 2>&1 || true',
        "      echo 'the service log of the failed start is in /var/log/mogaesup-failed-release.log' >&2",
        '      systemctl stop mogaesup.service 2>/dev/null || true',
        f'      if [ -f {binary}.good ]; then previous={binary}.good; else previous={binary}.prev; fi',
        '      if [ -f "$previous" ]; then install -m 755 -o root -g mogaesup "$previous" ' + binary + ' || true; '
        "else echo 'there is no previous binary to put back' >&2; fi",
        '    fi',
        '    if [ "$configured" = 1 ]; then',
        f'      for file in {SERVER_ENV} {SERVICE_UNIT}; do if [ -f "$file.prev" ]; then cp -p "$file.prev" "$file" || true; fi; done',
        '      systemctl daemon-reload || true',
        '    fi',
        # Before the swap the running release was never stopped and keeps the settings it started with.
        '    if [ "$swapped" = 1 ] || [ "$restarted" = 1 ]; then',
        '      systemctl restart mogaesup.service || true',
        f'      for attempt in $(seq 1 30); do if {health} >/dev/null; then echo \'the previous release answers again\' >&2; break; fi; sleep 2; done',
        '    fi',
        '  fi',
        '  exit "$status"',
        '}',
        'trap restore EXIT',
        # Two commands, not `&&`: a failed copy must stop the script here, before anything changes, and not be ignored
        # by `set -e`.
        f'if [ -f {binary} ]; then cp -p {binary} {binary}.prev.new; mv -f {binary}.prev.new {binary}.prev; fi',
        'install -d -m 750 -o mogaesup -g mogaesup /var/lib/mogaesup',
        # The settings the previous release runs with, kept (with their owner and mode) before the bootstrap rewrites them.
        f'for file in {SERVER_ENV} {SERVICE_UNIT}; do if [ -f "$file" ]; then cp -p "$file" "$file.prev.new"; mv -f "$file.prev.new" "$file.prev"; fi; done',
        'configured=1',
        ' '.join(shlex.quote(part) for part in [*bootstrap, '--no-restart']),
        # The new binary goes in under its final name by rename; the running process keeps the file it started from.
        'swapped=1',
        f'install -m 755 mogaesup-server {binary}.new',
        f'mv -f {binary}.new {binary}',
        'chown -R root:mogaesup /opt/mogaesup', 'chmod -R g+rX /opt/mogaesup/releases',
        'restarted=1',
        'systemctl restart mogaesup.service',
        f'for attempt in $(seq 1 30); do if {health}; then break; fi; sleep 2; done',
        'systemctl is-active mogaesup', health,
        'ok=1',
        # Housekeeping once the release answers; a failure here does not undo it.
        f'cp -p {binary} {binary}.good.new && mv -f {binary}.good.new {binary}.good || true',
        'cp -p release.json /opt/mogaesup/current-release.json 2>/dev/null || true',
        "ls -1dt /opt/mogaesup/releases/release-* | tail -n +6 | xargs -r rm -rf -- || true",
    ]


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', default='target/x86_64-unknown-linux-musl/release/mogaesup-server')
    parser.add_argument('--origin', default='https://mogaesup.com', help='Comma-separated site origins the server accepts')
    parser.add_argument('--factory-url', default=None,
                        help="Character server base URL for admins (backend/); left out, the server keeps its own, '' removes it")
    parser.add_argument('--factory-access', default=None, choices=('read', 'write', 'paid'),
                        help='What the studio screens may do through the server (FACTORY_ACCESS); left out, the server keeps '
                             'its own (read when it has none)')
    parser.add_argument('--factory-paid-monthly', type=int, default=None,
                        help='Paid studio requests allowed a month; left out, the server keeps its own (0 when it has none)')
    parser.add_argument('--model-store', default='s3://mogaesup-web-960243570517-apne2/models',
                        help='Where catalog models copied from the character server are kept')
    parser.add_argument('--studio-instance-id', default=None,
                        help="The studio's EC2 instance the server may start when it has powered itself off "
                             "(STUDIO_INSTANCE_ID; the stack keeps the last one given, '' turns it off)")
    parser.add_argument('--skip-provision', action='store_true')
    parser.add_argument('--provision-only', action='store_true',
                        help='Only list (with --yes, run) the stack change set; no binary is needed or installed')
    parser.add_argument('--yes', action='store_true',
                        help='Run the listed change set, unless it replaces the instance, the database or another kept resource')
    return parser.parse_args(argv)


def git(*args):
    return subprocess.run(['git', '-C', str(ROOT.parent), *args], capture_output=True, text=True, encoding='utf-8',
                          errors='replace')


def release_commit(binary, environ=None):
    """The commit the release is built from. The pipeline names it; run by hand, the server's files must be committed
    (what goes live is what was reviewed) and the binary built after the last commit that changed what it is built from."""
    environ = os.environ if environ is None else environ
    if environ.get('GITHUB_ACTIONS') == 'true':
        commit = environ.get('GITHUB_SHA', '')
    else:
        status = git('status', '--porcelain', '--untracked-files=all', '--', *RELEASE_PATHS)
        if status.returncode:
            raise RuntimeError('git status of the server files failed')
        changed = [line for line in status.stdout.splitlines() if line.strip()]
        if changed:
            raise RuntimeError('Uncommitted server files would go live unreviewed; commit them first: '
                               + '; '.join(changed[:10]))
        commit = git('rev-parse', 'HEAD').stdout.strip()
        # A commit only this PC has would go live before anyone else can see it, and the pipeline would not know it.
        if git('merge-base', '--is-ancestor', 'HEAD', 'origin/main').returncode:
            raise RuntimeError('HEAD is not on origin/main; push it (git fetch first if origin/main is stale)')
        built_from = git('log', '-1', '--format=%ct', '--', 'server/src', 'server/migrations', 'server/Cargo.toml',
                         'server/Cargo.lock', 'server/build.rs').stdout.strip()
        if built_from.isdigit() and binary.stat().st_mtime < int(built_from):
            raise RuntimeError('The binary is older than the last commit that changed the server; build it again '
                               '(README "배포" 1)')
        pipeline_running()
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise RuntimeError('The commit of this release could not be read')
    return commit


def pipeline_running():
    """Run by hand, refuse while a pipeline run on main may deploy too (its deploys take turns; this script is not one
    of them). The instance's install lock still keeps two installs apart."""
    try:
        done = subprocess.run(['gh', 'run', 'list', '--workflow', 'pipeline.yml', '--branch', 'main', '--limit', '20',
                               '--json', 'status', '--jq', '[.[] | select(.status != "completed")] | length'],
                              capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        print('Warning: gh is not available, so a pipeline run that deploys at the same time cannot be ruled out',
              flush=True)
        return
    if done.returncode == 0 and done.stdout.strip().isdigit() and int(done.stdout.strip()) > 0:
        raise RuntimeError('A pipeline run on main is queued or in progress and may deploy the server as well; wait '
                           'for it, or use its Run workflow (target server) instead')


def check_web_origin(outputs):
    """CloudFront (the web stack) must send /api/* to this stack's instance: the health check through the site passes
    for any healthy server it reaches."""
    try:
        web = aws('cloudformation', 'describe-stacks', '--region', REGION, '--stack-name', WEB_STACK)['Stacks'][0]
    except RuntimeError as error:
        print(f'Warning: the web stack could not be read, so where CloudFront sends /api/* is unchecked ({error})',
              flush=True)
        return
    given = {item['ParameterKey']: item.get('ParameterValue', '') for item in web.get('Parameters', [])}
    # The web stack's parameter and the server stack's output it is given from.
    pairs = (('ApiVpcOriginId', 'VpcOriginId'), ('ApiPrivateDns', 'ApiPrivateDns'))
    wrong = [f'{parameter}={given.get(parameter)!r} (this stack: {outputs[output]!r})'
             for parameter, output in pairs if outputs.get(output) and given.get(parameter) != outputs[output]]
    if wrong:
        raise RuntimeError(f"CloudFront ({WEB_STACK}) sends /api/* to another origin: {'; '.join(wrong)}. Deploy the web "
                           'stack (frontend/scripts/deploy-aws.ps1 -ProvisionOnly)')


def main():
    args = parse_args()
    if args.studio_instance_id and not re.fullmatch(r'i-[0-9a-f]{8,17}', args.studio_instance_id):
        raise RuntimeError('--studio-instance-id must be an EC2 instance id (i-…)')
    if args.provision_only:
        if aws('sts', 'get-caller-identity')['Account'] != ACCOUNT:
            raise RuntimeError('Unexpected AWS account')
        provision(args.studio_instance_id, args.yes)
        return
    binary = ROOT / args.binary
    if not binary.is_file() or binary.read_bytes()[:4] != b'\x7fELF':
        raise RuntimeError('Linux ELF release binary is required')
    commit = release_commit(binary)
    if aws('sts', 'get-caller-identity')['Account'] != ACCOUNT:
        raise RuntimeError('Unexpected AWS account')
    if not args.skip_provision:
        provision(args.studio_instance_id, args.yes)
    deadline = time.monotonic() + 1800
    while True:
        stack = aws('cloudformation', 'describe-stacks', '--region', REGION, '--stack-name', STACK)['Stacks'][0]
        if stack_settled(stack['StackStatus']):
            break
        if time.monotonic() > deadline:
            raise RuntimeError('Provisioning still pending; inspect the stack before retrying')
        print(f"Infrastructure {stack['StackStatus']}", flush=True)
        time.sleep(20)
    outputs = {item['OutputKey']: item['OutputValue'] for item in stack['Outputs']}
    instance, bucket = outputs['InstanceId'], outputs['RuntimeBucket']
    # The stack's role may start only the instance its parameter names, so the server is given that one.
    studio_instance = {item['ParameterKey']: item.get('ParameterValue', '')
                       for item in stack.get('Parameters', [])}.get('StudioInstanceId', '')
    if args.studio_instance_id is not None and args.studio_instance_id != studio_instance:
        raise RuntimeError('The stack names another studio instance; deploy without --skip-provision')

    release = datetime.now(timezone.utc).strftime('release-%Y%m%dT%H%M%SZ')
    receipt_dir = ROOT / 'artifacts' / release
    receipt_dir.mkdir(parents=True)
    # Which commit the server runs; the install keeps it as /opt/mogaesup/current-release.json.
    (receipt_dir / 'release.json').write_text(json.dumps({
        'release': release, 'git_commit': commit,
        'by': 'pipeline' if os.environ.get('GITHUB_ACTIONS') == 'true' else 'manual'}), encoding='utf-8')
    files = {'mogaesup-server': binary, 'bootstrap.py': ROOT / 'scripts/bootstrap-rust-server.py',
             'release.json': receipt_dir / 'release.json'}
    (receipt_dir / 'SHA256SUMS').write_text(''.join(f'{sha(path)}  {name}\n' for name, path in files.items()),
                                            encoding='ascii', newline='\n')
    files['SHA256SUMS'] = receipt_dir / 'SHA256SUMS'
    for name, path in files.items():
        subprocess.run(['aws', 's3', 'cp', str(path), f's3://{bucket}/{release}/{name}', '--region', REGION,
                        '--no-progress', '--only-show-errors'], check=True)

    commands = install_commands(release, bucket, bootstrap_command(args, outputs, studio_instance))
    parameters = receipt_dir / 'ssm-parameters.json'
    parameters.write_text(json.dumps({'commands': commands, 'executionTimeout': [str(COMMAND_SECONDS)]}),
                          encoding='utf-8')
    command = aws('ssm', 'send-command', '--region', REGION, '--instance-ids', instance, '--document-name',
                  'AWS-RunShellScript', '--parameters', f'file://{parameters.as_posix()}', '--comment',
                  f'Mogaesup verified {release}')['Command']['CommandId']
    receipt = {'release': release, 'instanceId': instance, 'bucket': bucket,
               'files': {name: sha(path) for name, path in files.items()}, 'commandId': command, 'outputs': outputs}
    (receipt_dir / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    time.sleep(3)
    result = wait_for_command(command, instance)
    (receipt_dir / 'ssm-result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    if result['Status'] != 'Success':
        raise RuntimeError(f"SSM {result['Status']}; inspect {receipt_dir / 'ssm-result.json'} (once the script has stopped "
                           'the service, a release that does not come up is replaced by the previous binary)')
    for line in result.get('StandardOutputContent', '').splitlines():
        if line.startswith('Studio gateway:'):
            print(line, flush=True)
    receipt['status'] = 'server-deployed'
    receipt['git_commit'] = commit
    (receipt_dir / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps({'receipt': str(receipt_dir / 'receipt.json'), 'status': receipt['status'], 'git_commit': commit}),
          flush=True)
    check_web_origin(outputs)
    # The first VPC origin creates CloudFront's service group; from then on only it may reach port 8080.
    if not args.skip_provision and service_group() and 'CloudFrontServiceGroup' not in {
            item['ParameterKey'] for item in stack.get('Parameters', []) if item.get('ParameterValue')}:
        provision(yes=args.yes)


if __name__ == '__main__':
    main()
