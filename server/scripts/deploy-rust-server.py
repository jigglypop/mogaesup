#!/usr/bin/env python3
"""Deploys the verified Linux release binary to the mogaesup-server stack through private S3 and SSM.

Uses the existing AWS CLI credentials only and never brings a secret to the developer machine.
Build first: see README "배포". Usage: python scripts/deploy-rust-server.py [--skip-provision] [--yes] [--factory-url URL]
[--factory-access read|write|paid] [--factory-paid-monthly N] [--studio-instance-id i-…]
Infrastructure changes are listed and left unapplied until --yes. The studio gateway flags are optional: one left out keeps
the value /etc/mogaesup/server.env already has, and the setting the server ended with is printed at the end.
"""
import argparse
import hashlib
import json
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
    """One line per resource change of `describe-change-set`; a replacement is called out."""
    lines = []
    for change in description.get('Changes', []):
        resource = change.get('ResourceChange', {})
        replacement = {'True': '  REPLACES the resource', 'Conditional': '  may replace the resource'}.get(
            resource.get('Replacement'), '')
        lines.append(f"{resource.get('Action', '?'):<8}{resource.get('LogicalResourceId', '?')} "
                     f"({resource.get('ResourceType', '?')}){replacement}")
    return lines


def provision(studio_instance=None, yes=False):
    group = service_group()
    overrides = [f'VpcId={VPC}', f'SubnetA={SUBNETS[0]}', f'SubnetB={SUBNETS[1]}', f'ImageId={IMAGE}']
    if group:
        overrides.append(f'CloudFrontServiceGroup={group}')
    # Left out, the stack keeps the instance it was given before.
    if studio_instance is not None:
        overrides.append(f'StudioInstanceId={studio_instance}')
    deploy = ['aws', 'cloudformation', 'deploy', '--region', REGION, '--stack-name', STACK,
              '--template-file', str(ROOT / 'infra/aws-server.yaml'), '--parameter-overrides', *overrides,
              '--capabilities', 'CAPABILITY_IAM', '--tags', 'application=mogaesup', '--no-fail-on-empty-changeset']
    if yes:
        subprocess.run(deploy, check=True)
        return
    # Without --yes the change set is made but not executed: what it would do is listed, and the run stops.
    process = subprocess.run([*deploy, '--no-execute-changeset'], capture_output=True, text=True, encoding='utf-8',
                             errors='replace')
    if process.returncode:
        raise RuntimeError(f'aws cloudformation deploy failed: {process.stderr.strip()}')
    arn = change_set_arn(process.stdout + process.stderr)
    if arn is None:
        if 'No changes to deploy' in process.stdout:
            return
        raise RuntimeError('The change set could not be read from the aws output; run again with --yes to apply the '
                           'infrastructure changes without listing them')
    for line in change_lines(aws('cloudformation', 'describe-change-set', '--region', REGION, '--change-set-name', arn)):
        print(line, flush=True)
    try:
        aws('cloudformation', 'delete-change-set', '--region', REGION, '--change-set-name', arn)
    except RuntimeError:
        pass
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
    """The SSM script lines that install a release. The binary being replaced is kept as mogaesup-server.prev; once the
    service is stopped, any failure up to a healthy new release (the exit trap) puts that binary back and starts it again."""
    folder = f'/opt/mogaesup/releases/{release}'
    binary = '/opt/mogaesup/mogaesup-server'
    health = 'curl -fsS http://127.0.0.1:8080/api/health'
    return [
        'set -eu', 'dnf install -y postgresql17 > /var/log/mogaesup-packages.log',
        f'install -d -m 750 {folder}',
        f'aws s3 cp s3://{bucket}/{release}/ {folder}/ --recursive --region {REGION} --no-progress --only-show-errors',
        f'cd {folder}', 'sha256sum -c SHA256SUMS',
        'curl --fail --silent --show-error https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /opt/mogaesup/global-bundle.pem',
        'stopped=0; swapped=0; ok=0',
        'restore() {',
        '  status=$?; trap - EXIT',
        '  if [ "$stopped" = 1 ] && [ "$ok" != 1 ]; then',
        '    [ "$status" != 0 ] || status=1',
        "    echo 'the new release did not come up; starting the previous one again' >&2",
        '    journalctl -u mogaesup -n 40 --no-pager >&2 || true',
        '    systemctl stop mogaesup.service 2>/dev/null || true',
        '    if [ "$swapped" = 1 ]; then',
        f'      if [ -f {binary}.prev ]; then install -m 755 -o root -g mogaesup {binary}.prev {binary} || true; else echo \'there is no previous binary to put back\' >&2; fi',
        '    fi',
        '    systemctl restart mogaesup.service || true',
        f'    for attempt in $(seq 1 30); do if {health} >/dev/null; then echo \'the previous release answers again\' >&2; break; fi; sleep 2; done',
        '  fi',
        '  exit "$status"',
        '}',
        'trap restore EXIT',
        'stopped=1',
        'systemctl stop mogaesup.service 2>/dev/null || true',
        # Two commands, not `&&`: a failed copy must stop the script here, before the swap, and not be ignored by `set -e`.
        f'if [ -f {binary} ]; then cp -p {binary} {binary}.prev.new; mv -f {binary}.prev.new {binary}.prev; fi',
        'swapped=1',
        f'install -m 755 mogaesup-server {binary}',
        'chown -R root:mogaesup /opt/mogaesup', 'chmod -R g+rX /opt/mogaesup/releases',
        'install -d -m 750 -o mogaesup -g mogaesup /var/lib/mogaesup',
        ' '.join(shlex.quote(part) for part in bootstrap),
        f'for attempt in $(seq 1 30); do if {health}; then break; fi; sleep 2; done',
        'systemctl is-active mogaesup', health,
        'ok=1',
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
    parser.add_argument('--yes', action='store_true', help='Apply infrastructure changes without listing them first')
    return parser.parse_args(argv)


def main():
    args = parse_args()
    if args.studio_instance_id and not re.fullmatch(r'i-[0-9a-f]{8,17}', args.studio_instance_id):
        raise RuntimeError('--studio-instance-id must be an EC2 instance id (i-…)')
    if aws('sts', 'get-caller-identity')['Account'] != ACCOUNT:
        raise RuntimeError('Unexpected AWS account')
    binary = ROOT / args.binary
    if not binary.is_file() or binary.read_bytes()[:4] != b'\x7fELF':
        raise RuntimeError('Linux ELF release binary is required')
    if not args.skip_provision:
        provision(args.studio_instance_id, args.yes)
    deadline = time.monotonic() + 1800
    while True:
        stack = aws('cloudformation', 'describe-stacks', '--region', REGION, '--stack-name', STACK)['Stacks'][0]
        if stack['StackStatus'] in ('CREATE_COMPLETE', 'UPDATE_COMPLETE'):
            break
        if 'FAILED' in stack['StackStatus'] or 'ROLLBACK' in stack['StackStatus']:
            raise RuntimeError(stack['StackStatus'])
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
    files = {'mogaesup-server': binary, 'bootstrap.py': ROOT / 'scripts/bootstrap-rust-server.py'}
    (receipt_dir / 'SHA256SUMS').write_text(''.join(f'{sha(path)}  {name}\n' for name, path in files.items()),
                                            encoding='ascii', newline='\n')
    files['SHA256SUMS'] = receipt_dir / 'SHA256SUMS'
    for name, path in files.items():
        subprocess.run(['aws', 's3', 'cp', str(path), f's3://{bucket}/{release}/{name}', '--region', REGION,
                        '--no-progress', '--only-show-errors'], check=True)

    commands = install_commands(release, bucket, bootstrap_command(args, outputs, studio_instance))
    parameters = receipt_dir / 'ssm-parameters.json'
    parameters.write_text(json.dumps({'commands': commands, 'executionTimeout': ['900']}), encoding='utf-8')
    command = aws('ssm', 'send-command', '--region', REGION, '--instance-ids', instance, '--document-name',
                  'AWS-RunShellScript', '--parameters', f'file://{parameters.as_posix()}', '--comment',
                  f'Mogaesup verified {release}')['Command']['CommandId']
    receipt = {'release': release, 'instanceId': instance, 'bucket': bucket,
               'files': {name: sha(path) for name, path in files.items()}, 'commandId': command, 'outputs': outputs}
    (receipt_dir / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    time.sleep(3)
    for _ in range(90):
        result = aws('ssm', 'get-command-invocation', '--region', REGION, '--command-id', command, '--instance-id', instance)
        if result['Status'] not in ('Pending', 'InProgress', 'Delayed'):
            break
        print('Installing the verified release via SSM', flush=True)
        time.sleep(10)
    (receipt_dir / 'ssm-result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    if result['Status'] != 'Success':
        raise RuntimeError(f"SSM {result['Status']}; inspect {receipt_dir / 'ssm-result.json'} (once the script has stopped "
                           'the service, a release that does not come up is replaced by the previous binary)')
    for line in result.get('StandardOutputContent', '').splitlines():
        if line.startswith('Studio gateway:'):
            print(line, flush=True)
    receipt['status'] = 'server-deployed'
    (receipt_dir / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps({'receipt': str(receipt_dir / 'receipt.json'), 'status': receipt['status']}), flush=True)
    # The first VPC origin creates CloudFront's service group; from then on only it may reach port 8080.
    if not args.skip_provision and service_group() and 'CloudFrontServiceGroup' not in {
            item['ParameterKey'] for item in stack.get('Parameters', []) if item.get('ParameterValue')}:
        provision(yes=args.yes)


if __name__ == '__main__':
    main()
