"""Copy the existing server gateway key into the studio provider configuration without exposing credentials."""
import argparse
import json
import re
import sys
import uuid

from botocore.config import Config
import boto3


def sync(client, source, destination, request_id):
    gateway = client.get_secret_value(SecretId=source)['SecretString'].strip()
    if not re.fullmatch(r'[A-Za-z0-9._~-]{16,256}', gateway):
        raise RuntimeError('The existing server gateway key does not satisfy the studio contract')
    previous = client.get_secret_value(SecretId=destination)
    settings = json.loads(previous['SecretString'])
    if not isinstance(settings, dict):
        raise RuntimeError('Studio provider configuration must be a JSON object')
    if settings.get('STUDIO_GATEWAY_KEY') == gateway:
        return {'changed': False, 'version_id': previous['VersionId']}
    # Refuse an observed concurrent configuration change; never overwrite a known newer provider version.
    current = client.describe_secret(SecretId=destination)['VersionIdsToStages']
    if 'AWSCURRENT' not in current.get(previous['VersionId'], []):
        raise RuntimeError('Studio provider configuration changed; inspect before repeating')
    settings['STUDIO_GATEWAY_KEY'] = gateway
    result = client.put_secret_value(SecretId=destination, ClientRequestToken=request_id,
                                    SecretString=json.dumps(settings))
    # Both sides are read again: only the equality is returned, never either credential.
    installed = client.get_secret_value(SecretId=destination)
    existing = client.get_secret_value(SecretId=source)['SecretString'].strip()
    if json.loads(installed['SecretString']).get('STUDIO_GATEWAY_KEY') != existing:
        raise RuntimeError('Gateway equality was not verified; inspect the existing version before repeating')
    return {'changed': True, 'version_id': result['VersionId'], 'previous_version_id': previous['VersionId'],
            'gateway_matches': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--request-id', required=True, type=lambda value: str(uuid.UUID(value)))
    parser.add_argument('--region', default='ap-northeast-2')
    args = parser.parse_args()
    session = boto3.Session(region_name=args.region)
    if session.client('sts').get_caller_identity()['Account'] != '960243570517':
        raise RuntimeError('Unexpected AWS deployment account')
    client = session.client('secretsmanager', config=Config(connect_timeout=5, read_timeout=20,
                                                           retries={'total_max_attempts': 1}))
    print(json.dumps(sync(client, args.source, args.destination, args.request_id)))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # SDK/JSON exceptions may contain secret contents. A timeout is uncertain, never an automatic new write.
        print('Gateway synchronization did not finish. Inspect this request ID before repeating.', file=sys.stderr)
        sys.exit(1)
