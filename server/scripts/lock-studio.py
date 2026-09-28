#!/usr/bin/env python3
"""Closes the character studio's public CloudFront (stack gaesup-asset-studio) to all but this server and listed IPs.

The mogaesup server sends `x-gateway-key` with every studio request (FACTORY_GATEWAY_KEY, the server stack's
FactoryGatewaySecret). A CloudFront Function on the studio's viewer requests lets that key and the given IPs through
and answers everything else 403. The key is read from Secrets Manager and never printed.

The association is made outside the studio's own stack: a later deploy of gaesup-asset-studio drops it, so run this
again after one (or add the function to gaesup-character's infra/ec2.yaml).

Usage: python scripts/lock-studio.py --allow-ip 203.0.113.7 [--allow-ip ...]
       python scripts/lock-studio.py --unlock
"""
import argparse
import ipaddress
import json
import subprocess
import tempfile
from pathlib import Path

REGION = 'ap-northeast-2'
ACCOUNT = '960243570517'
SERVER_STACK = 'mogaesup-server'
DISTRIBUTION = 'EVYDOGNZWWWC9'
FUNCTION = 'gaesup-studio-gate'


def aws(*args):
    process = subprocess.run(['aws', *args, '--no-cli-pager', '--output', 'json'], capture_output=True)
    stdout = process.stdout.decode('utf-8', errors='replace')
    if process.returncode:
        raise RuntimeError(f"AWS {args[0]} {args[1]} failed: {process.stderr.decode('utf-8', errors='replace').strip()}")
    return json.loads(stdout) if stdout.strip() else {}


def gate_code(key, ips):
    # cloudfront-js-2.0; the key and addresses are baked in because functions cannot read secrets at run time.
    return f"""var KEY = {json.dumps(key)};
var IPS = {json.dumps(ips)};
function handler(event) {{
  var request = event.request;
  var key = request.headers['x-gateway-key'];
  if ((key && key.value === KEY) || IPS.indexOf(event.viewer.ip) !== -1) return request;
  return {{
    statusCode: 403,
    statusDescription: 'Forbidden',
    headers: {{ 'content-type': {{ value: 'text/plain; charset=utf-8' }}, 'cache-control': {{ value: 'no-store' }} }},
    body: {{ encoding: 'text', data: 'This studio is private.' }}
  }};
}}
"""


def publish(code):
    """Creates or updates the gate function and publishes it; returns its ARN."""
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / 'gate.js'
        path.write_text(code, encoding='utf-8', newline='\n')
        config = json.dumps({'Comment': 'mogaesup: studio only for the mogaesup server and owner IPs',
                             'Runtime': 'cloudfront-js-2.0'})
        try:
            etag = aws('cloudfront', 'describe-function', '--name', FUNCTION)['ETag']
            etag = aws('cloudfront', 'update-function', '--name', FUNCTION, '--if-match', etag,
                       '--function-config', config, '--function-code', f'fileb://{path.as_posix()}')['ETag']
        except RuntimeError as error:
            if 'NoSuchFunctionExists' not in str(error):
                raise
            etag = aws('cloudfront', 'create-function', '--name', FUNCTION, '--function-config', config,
                       '--function-code', f'fileb://{path.as_posix()}')['ETag']
    aws('cloudfront', 'publish-function', '--name', FUNCTION, '--if-match', etag)
    return aws('cloudfront', 'describe-function', '--name', FUNCTION, '--stage', 'LIVE')['FunctionSummary'][
        'FunctionMetadata']['FunctionARN']


def associate(arn):
    """Puts the gate on every behavior of the studio distribution, or takes it off when `arn` is None."""
    current = aws('cloudfront', 'get-distribution-config', '--id', DISTRIBUTION)
    config, etag = current['DistributionConfig'], current['ETag']
    items = [{'FunctionARN': arn, 'EventType': 'viewer-request'}] if arn else []
    behaviors = [config['DefaultCacheBehavior'], *config.get('CacheBehaviors', {}).get('Items', [])]
    for behavior in behaviors:
        others = [item for item in behavior.get('FunctionAssociations', {}).get('Items', [])
                  if item['EventType'] != 'viewer-request']
        behavior['FunctionAssociations'] = {'Quantity': len(others) + len(items), 'Items': others + items}
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / 'distribution.json'
        path.write_text(json.dumps(config), encoding='utf-8')
        aws('cloudfront', 'update-distribution', '--id', DISTRIBUTION, '--if-match', etag,
            '--distribution-config', f'file://{path.as_posix()}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--allow-ip', action='append', default=[], help='A viewer address let in without the key')
    parser.add_argument('--unlock', action='store_true', help='Take the gate off the studio again')
    args = parser.parse_args()
    if aws('sts', 'get-caller-identity')['Account'] != ACCOUNT:
        raise RuntimeError('Unexpected AWS account')
    if args.unlock:
        associate(None)
        print(json.dumps({'distribution': DISTRIBUTION, 'gate': 'removed'}))
        return
    ips = [str(ipaddress.ip_address(value)) for value in args.allow_ip]
    outputs = {item['OutputKey']: item['OutputValue'] for item in
               aws('cloudformation', 'describe-stacks', '--region', REGION, '--stack-name', SERVER_STACK)['Stacks'][0]['Outputs']}
    key = aws('secretsmanager', 'get-secret-value', '--region', REGION,
              '--secret-id', outputs['FactoryGatewaySecretArn'])['SecretString']
    arn = publish(gate_code(key, ips))
    associate(arn)
    print(json.dumps({'distribution': DISTRIBUTION, 'gate': FUNCTION, 'allowIps': ips}))


if __name__ == '__main__':
    main()
