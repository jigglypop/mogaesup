#!/usr/bin/env python3
"""Changes the studio instance role's permissions (stack gaesup-asset-studio) without touching the instance.

A plain stack update can replace or restart the instance: the image, the user data or the security group may differ
from what the live stack has. This script makes a change set with the image the instance runs now (read from EC2 at
run time) and every other parameter as the stack has it, prints it, and runs it only when every change is one of the
allowed IAM changes and only with --execute. Anything else (the instance, its security group, the CloudFront
distribution and its gate) makes it stop and delete the change set.

    python backend/infra/update-studio-role.py                    # the change set of --from live, printed, then deleted
    python backend/infra/update-studio-role.py --execute          # the same, run when it holds only allowed changes
    python backend/infra/update-studio-role.py --from repo        # backend/infra/ec2.yaml as it is in this checkout

--from live (default) takes the template the stack runs now and changes only two things in it: the image parameter
becomes a plain image id (the image the instance runs), and a policy resource with what that template lacks is added
(s3:DeleteObject under assets/, ssm:PutParameter for /asset-studio/current-release). The change set must then hold that
one addition. --from repo applies this checkout's ec2.yaml, whose role permissions are the StudioAccessPolicy resource:
allowed are that policy's addition or change and the role losing its inline policies, nothing else. Moving the inline
policy out leaves the role without its storage permissions for the seconds between those two steps, so run that one
while the studio has no work running.
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STACK = 'gaesup-asset-studio'
REGION = 'ap-northeast-2'
ADDON = 'StudioAccessAddOn'
# What --from live adds to the running template, in its own two-space Resources indentation.
ADDON_YAML = f'''  {ADDON}:
    # Added by backend/infra/update-studio-role.py: what the role lacks, as an IAM-only change.
    Type: AWS::IAM::Policy
    Properties:
      PolicyName: {ADDON}
      Roles: [!Ref InstanceRole]
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Action: ['s3:DeleteObject']
            Resource: !Sub 'arn:${{AWS::Partition}}:s3:::${{AssetBucket}}/assets/*'
          - Effect: Allow
            Action: ['ssm:PutParameter']
            Resource: !Sub 'arn:${{AWS::Partition}}:ssm:${{AWS::Region}}:${{AWS::AccountId}}:parameter/asset-studio/current-release'
'''
SSM_IMAGE = "AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>"
SETTLED = ('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE')


class Refused(Exception):
    pass


def aws(*args, region=REGION):
    process = subprocess.run(['aws', *args, '--region', region, '--no-cli-pager', '--output', 'json'],
                             capture_output=True)
    # stdout alone is parsed: a warning on stderr must not break it.
    stdout = process.stdout.decode('utf-8', errors='replace')
    if process.returncode:
        raise RuntimeError(f"AWS {args[0]} {args[1]} failed: {process.stderr.decode('utf-8', errors='replace').strip()}")
    return json.loads(stdout) if stdout.strip() else {}


def live_template(body, image):
    """The running template with the image pinned and the add-on policy, or Refused when its layout is not the one
    this script knows (then use --from repo, or change the template by hand)."""
    if isinstance(body, dict):
        parameters, resources = body.get('Parameters', {}), body.get('Resources', {})
        if 'InstanceRole' not in resources or 'AssetBucket' not in parameters or 'ImageId' not in parameters:
            raise Refused('the running template has no InstanceRole, AssetBucket or ImageId')
        if ADDON in resources:
            raise Refused(f'the running template already has {ADDON}')
        parameters['ImageId'] = {'Type': 'AWS::EC2::Image::Id', 'Default': image}
        resources[ADDON] = {'Type': 'AWS::IAM::Policy', 'Properties': {
            'PolicyName': ADDON, 'Roles': [{'Ref': 'InstanceRole'}],
            'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
                {'Effect': 'Allow', 'Action': ['s3:DeleteObject'],
                 'Resource': {'Fn::Sub': 'arn:${AWS::Partition}:s3:::${AssetBucket}/assets/*'}},
                {'Effect': 'Allow', 'Action': ['ssm:PutParameter'], 'Resource': {'Fn::Sub':
                    'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/asset-studio/current-release'}}]}}}
        return json.dumps(body, indent=1)
    text = body.replace('\r\n', '\n')
    if ADDON in text:
        raise Refused(f'the running template already has {ADDON}')
    if not re.search(r'^Resources:\n', text, re.M) or not re.search(r'^  InstanceRole:\n', text, re.M) \
            or not re.search(r'^  AssetBucket:', text, re.M):
        raise Refused('the running template does not have the layout this script edits (Resources, InstanceRole, AssetBucket)')
    image = re.compile(r"^(  ImageId:\n(?:    #.*\n)*    Type: )'?" + re.escape(SSM_IMAGE) + r"'?\n(    Default: \S+\n)?", re.M)
    found = image.findall(text)
    if len(found) == 1:
        text = image.sub(lambda match: f"{match.group(1)}'AWS::EC2::Image::Id'\n", text)
    elif not re.search(r"^  ImageId:\n(?:    #.*\n)*    Type: '?AWS::EC2::Image::Id'?\n", text, re.M):
        raise Refused('the image parameter of the running template is not the one this script pins')
    outputs = re.search(r'^Outputs:', text, re.M)
    if outputs and outputs.start() < text.index('\nResources:'):
        raise Refused('Outputs come before Resources in the running template')
    at = outputs.start() if outputs else len(text)
    if not text[:at].endswith('\n'):
        raise Refused('the running template does not end its Resources with a line break')
    return text[:at] + ADDON_YAML + text[at:]


def parameters_for(template_parameters, live, image):
    """Every parameter of the new template: the image the instance runs, the stack's values for the others it has,
    and the template's defaults for new ones."""
    values = []
    for name in template_parameters:
        if name == 'ImageId':
            values.append({'ParameterKey': name, 'ParameterValue': image})
        elif name in live:
            values.append({'ParameterKey': name, 'UsePreviousValue': True})
    return values


def template_parameters(text):
    """The parameter names of a YAML (or JSON) template, from its top-level Parameters block."""
    if text.lstrip().startswith('{'):
        return list(json.loads(text).get('Parameters', {}))
    block = re.search(r'^Parameters:\n((?:(?:  .*)?\n)+)', text, re.M)
    return re.findall(r'^  (\w+):', block.group(1), re.M) if block else []


def evaluate(changes, mode):
    """The reasons the change set may not run; empty when it holds only the allowed IAM changes."""
    problems = []
    seen = []
    for change in changes:
        resource = change.get('ResourceChange', {})
        action, name = resource.get('Action'), resource.get('LogicalResourceId')
        kind, replacement = resource.get('ResourceType'), resource.get('Replacement')
        seen.append(name)
        targets = {(detail.get('Target', {}).get('Attribute'), detail.get('Target', {}).get('Name'))
                   for detail in resource.get('Details', [])}
        if mode == 'live' and name == ADDON and action == 'Add' and kind == 'AWS::IAM::Policy':
            continue
        if mode == 'repo' and name == 'StudioAccessPolicy' and kind == 'AWS::IAM::Policy' and action in ('Add', 'Modify') \
                and replacement in (None, 'False'):
            continue
        if mode == 'repo' and name == 'InstanceRole' and action == 'Modify' and replacement == 'False' \
                and targets <= {('Properties', 'Policies')} and targets:
            continue
        problems.append(f'{action} {name} ({kind}), replacement {replacement or "-"}, '
                        f"changes {', '.join(sorted(f'{a}.{n}' if n else str(a) for a, n in targets)) or '-'}")
    wanted = {'live': ADDON, 'repo': 'StudioAccessPolicy'}[mode]
    if wanted not in seen and not problems:
        problems.append(f'the change set does not change {wanted}')
    return problems


def change_lines(changes):
    lines = []
    for change in changes:
        resource = change.get('ResourceChange', {})
        replacement = {'True': '  REPLACES the resource', 'Conditional': '  may replace the resource'}.get(
            resource.get('Replacement'), '')
        lines.append(f"{resource.get('Action', '?'):<8}{resource.get('LogicalResourceId', '?')} "
                     f"({resource.get('ResourceType', '?')}){replacement}")
        for detail in resource.get('Details', []):
            target = detail.get('Target', {})
            name = '.'.join(part for part in (target.get('Attribute'), target.get('Name')) if part) or '?'
            recreation = {'Always': '  requires replacement', 'Conditionally': '  may require replacement'}.get(
                target.get('RequiresRecreation'), '')
            lines.append(f'        {name}{recreation}')
    return lines


def wait_for(check, what, seconds=900, interval=10):
    deadline = time.monotonic() + seconds
    while True:
        done = check()
        if done is not None:
            return done
        if time.monotonic() > deadline:
            raise RuntimeError(f'{what} did not finish within {seconds} s')
        time.sleep(interval)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--stack', default=STACK)
    parser.add_argument('--region', default=REGION)
    parser.add_argument('--from', dest='source', choices=('live', 'repo'), default='live')
    parser.add_argument('--execute', action='store_true', help='run the change set when it holds only allowed changes')
    args = parser.parse_args(argv)

    def call(*parts):
        return aws(*parts, region=args.region)

    stack = call('cloudformation', 'describe-stacks', '--stack-name', args.stack)['Stacks'][0]
    if stack['StackStatus'] not in SETTLED:
        raise SystemExit(f"{args.stack} is {stack['StackStatus']}; wait until it settles")
    live = {item['ParameterKey']: item.get('ParameterValue') for item in stack.get('Parameters', [])}
    instance = call('cloudformation', 'describe-stack-resource', '--stack-name', args.stack,
                    '--logical-resource-id', 'Instance')['StackResourceDetail']['PhysicalResourceId']
    described = call('ec2', 'describe-instances', '--instance-ids', instance)['Reservations'][0]['Instances'][0]
    image = described['ImageId']
    print(f"Instance {instance} ({described['State']['Name']}) runs {image}")
    try:
        release = call('ssm', 'get-parameter', '--name', '/asset-studio/current-release')['Parameter']['Value']
        print(f"Installed release (SSM): {release}; the stack's ReleaseKey stays {live.get('ReleaseKey')}")
    except RuntimeError:
        print(f"The stack's ReleaseKey stays {live.get('ReleaseKey')} (no /asset-studio/current-release yet)")

    if args.source == 'live':
        body = call('cloudformation', 'get-template', '--stack-name', args.stack, '--template-stage', 'Original')['TemplateBody']
        try:
            text = live_template(body, image)
        except Refused as error:
            raise SystemExit(f'Refused: {error}')
    else:
        text = (HERE / 'ec2.yaml').read_text(encoding='utf-8')
    names = template_parameters(text)
    if 'ImageId' not in names:
        raise SystemExit('Refused: the template has no ImageId parameter')
    with tempfile.TemporaryDirectory(prefix='studio-role-') as folder:
        template = Path(folder) / 'template.yaml'
        template.write_text(text, encoding='utf-8', newline='\n')
        parameters = Path(folder) / 'parameters.json'
        parameters.write_text(json.dumps(parameters_for(names, live, image)), encoding='utf-8')
        name = time.strftime('studio-role-%Y%m%d%H%M%S', time.gmtime())
        arn = call('cloudformation', 'create-change-set', '--stack-name', args.stack, '--change-set-name', name,
                   '--change-set-type', 'UPDATE', '--template-body', f'file://{template.as_posix()}',
                   '--parameters', f'file://{parameters.as_posix()}', '--capabilities', 'CAPABILITY_IAM',
                   '--description', f'IAM only ({args.source}), made by update-studio-role.py')['Id']

    def created():
        found = call('cloudformation', 'describe-change-set', '--change-set-name', arn)
        return found if found['Status'] in ('CREATE_COMPLETE', 'FAILED') else None
    description = wait_for(created, 'The change set')
    changes = description.get('Changes', [])
    while description.get('NextToken'):
        description = call('cloudformation', 'describe-change-set', '--change-set-name', arn,
                           '--next-token', description['NextToken'])
        changes += description.get('Changes', [])

    def delete():
        try:
            call('cloudformation', 'delete-change-set', '--change-set-name', arn)
        except RuntimeError as error:
            print(f'The change set {arn} could not be deleted: {error}', file=sys.stderr)
    if description['Status'] == 'FAILED':
        delete()
        raise SystemExit(f"The change set failed: {description.get('StatusReason')}")
    for line in change_lines(changes):
        print(line)
    problems = evaluate(changes, args.source)
    if problems:
        delete()
        print('Refused, the change set was deleted. Changes beyond the role permissions:', file=sys.stderr)
        for problem in problems:
            print(f'  {problem}', file=sys.stderr)
        raise SystemExit(2)
    if not args.execute:
        delete()
        print('Only allowed IAM changes. Nothing was applied; run again with --execute to apply them.')
        return
    call('cloudformation', 'execute-change-set', '--change-set-name', arn)

    def updated():
        status = call('cloudformation', 'describe-stacks', '--stack-name', args.stack)['Stacks'][0]['StackStatus']
        return None if status.endswith('_IN_PROGRESS') else status
    status = wait_for(updated, 'The stack update')
    if status != 'UPDATE_COMPLETE':
        raise SystemExit(f'The stack ended {status}; inspect its events')
    after = call('ec2', 'describe-instances', '--instance-ids', instance)['Reservations'][0]['Instances'][0]
    print(f"Applied. Instance {instance} still runs {after['ImageId']} ({after['State']['Name']}).")


if __name__ == '__main__':
    main()
