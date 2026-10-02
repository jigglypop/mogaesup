"""Import one reviewed hair GLB through the existing owner-1 studio API.

This direct operator channel does not pass through Rust's monthly-request
aggregate. The backend still records the asset, job and idempotency receipts.
Only uploaded-model fitting is offered: provider generation/rigging is absent.
Unrigged input is the default; fitted native hair requires an explicit mode.
"""
from contextlib import contextmanager
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import uuid

import boto3
from botocore.config import Config
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.services.asset_delivery import DeliveryPolicy, inspect_glb
from src.services.glb import parse_glb
from src.services.native_hair_upload import validate_native_hair

ACCOUNT = '960243570517'
REGION = 'ap-northeast-2'
ORIGIN = 'https://dtcd471nsfyvo.cloudfront.net'
SECRET = 'arn:aws:secretsmanager:ap-northeast-2:960243570517:secret:FactoryGatewaySecret-f7K398lwgvPW-hfKn2g'
MAX_BYTES = 256 * 1024 * 1024
HASH = re.compile(r'[a-f0-9]{64}')
ID = re.compile(r'[a-f0-9]{24}')
PHASES = ('upload', 'register', 'fit')
ZERO_LIMITS = ('image_tasks', 'reference_tasks', 'expression_tasks', 'meshy_tasks', 'meshy_rig_tasks', 'meshy_animation_tasks')


class ImportStopped(RuntimeError):
    """A fixed safe message; upstream bodies/SDK exceptions never escape."""


def stop(message):
    raise ImportStopped(message)


def fixed_input(args):
    if not HASH.fullmatch(args.sha256) or not HASH.fullmatch(args.body_sha256):
        stop('Expected SHA-256 values are required.')
    if not ID.fullmatch(args.body_job) or not ID.fullmatch(args.body_version):
        stop('An explicit body job and native version are required.')
    name = args.name.strip()
    if not 1 <= len(name) <= 100:
        stop('Name must contain 1 to 100 characters.')
    source = Path(args.file)
    if source.suffix.lower() != '.glb' or not source.is_file() or not 0 < source.stat().st_size <= MAX_BYTES:
        stop('A nonempty GLB no larger than 256 MiB is required.')
    with source.open('rb') as stream:
        content = stream.read(MAX_BYTES+1)
    if len(content) > MAX_BYTES or hashlib.sha256(content).hexdigest() != args.sha256:
        stop('Local GLB SHA-256 does not match.')
    fitted_native = getattr(args, 'fitted_native_hair', False)
    submitted = {'sha256':args.sha256, 'bytes':len(content), 'name':name, 'slot':'hair',
        'body_job':args.body_job, 'body_version':args.body_version, 'body_sha256':args.body_sha256,
        'input_mode':'fitted_native_hair' if fitted_native else 'unrigged_hair'}
    if fitted_native:
        try: validate_native_hair(content)
        except ValueError: stop('Local fitted native hair validation failed.')
        return submitted, content
    try:
        check = inspect_glb(content, DeliveryPolicy(max_file_bytes=MAX_BYTES), budget_warnings=True)
        doc, _ = parse_glb(content, strict=True)
    except Exception:
        stop('Local GLB inspection failed.')
    if check['errors'] or not doc.get('meshes') or doc.get('skins') or doc.get('animations'):
        stop('Only validated, unrigged hair GLBs without clips are accepted.')
    meshes = set()
    for node in doc.get('nodes', []):
        if 'skin' in node:
            stop('Only unrigged hair is accepted.')
        if 'mesh' in node:
            if type(node['mesh']) is not int or not 0 <= node['mesh'] < len(doc['meshes']):
                stop('Invalid mesh references are refused.')
            tags = node.get('extras') or {}
            if not isinstance(tags, dict) or not any(tags.get(key) == 'hair' for key in ('part_role', 'standard_slot')):
                stop('Every mesh must be explicitly tagged as hair.')
            if any(tags.get(key) not in (None, 'hair') for key in ('part_role', 'standard_slot')):
                stop('Conflicting mesh roles are refused.')
            meshes.add(node['mesh'])
    if meshes != set(range(len(doc['meshes']))):
        stop('Hidden or unassigned meshes are refused.')
    if any(item.get('uri') and not item['uri'].startswith('data:') for item in doc.get('buffers', [])+doc.get('images', [])):
        stop('External GLB resources are refused.')
    return submitted, content


@contextmanager
def receipt_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name+'.lock')
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    stream = os.fdopen(descriptor, 'r+b')
    try:
        if os.name == 'nt':
            import msvcrt
            try:
                if os.fstat(stream.fileno()).st_size == 0:
                    stream.write(b'0'); stream.flush()
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError: stop('This receipt is already in use.')
        else:
            import fcntl
            try: fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError: stop('This receipt is already in use.')
        yield
    finally:
        stream.close()


def save(path, receipt):
    temporary = path.with_name(path.name+'.'+str(uuid.uuid4())+'.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(receipt, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != 'nt':
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(directory)
            finally: os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def read_receipt(path, submitted):
    if not path.exists():
        return {'schema':1, 'owner_id':1, 'origin':ORIGIN, 'input':submitted, 'phases':{},
                'operator_channel':'direct_owner_1_without_rust_monthly_request_aggregate', 'provider_calls':0}
    try:
        receipt = json.loads(path.read_text(encoding='utf-8'))
        if set(receipt) != {'schema','owner_id','origin','input','phases','operator_channel','provider_calls'}:
            raise ValueError()
        if (type(receipt['schema']) is not int or receipt['schema'] != 1
                or type(receipt['owner_id']) is not int or receipt['owner_id'] != 1 or receipt['origin'] != ORIGIN
                or receipt['input'] != submitted or type(receipt['provider_calls']) is not int or receipt['provider_calls'] != 0
                or receipt['operator_channel'] != 'direct_owner_1_without_rust_monthly_request_aggregate'
                or not isinstance(receipt['phases'], dict) or not set(receipt['phases']) <= set(PHASES)):
            raise ValueError()
        seen_gap = False
        for phase in PHASES:
            item = receipt['phases'].get(phase)
            if item is None:
                seen_gap = True; continue
            if seen_gap or not isinstance(item, dict) or not set(item) <= {'key','state','id','http_status','status'}:
                raise ValueError()
            if str(uuid.UUID(item['key'])) != item['key'] or item['state'] not in ('intent','accepted','uncertain','rejected'):
                raise ValueError()
            if item['state'] == 'accepted':
                if item.get('id') != expected_id(receipt, phase): raise ValueError()
            elif 'id' in item or 'status' in item:
                raise ValueError()
            if 'status' in item and phase != 'fit': raise ValueError()
            if 'http_status' in item and (type(item['http_status']) is not int or not 100 <= item['http_status'] <= 599):
                raise ValueError()
            if 'status' in item and (not isinstance(item['status'], str) or not re.fullmatch(r'[a-z_]{1,40}', item['status'])):
                raise ValueError()
        for prior, later in zip(PHASES, PHASES[1:]):
            if later in receipt['phases'] and receipt['phases'][prior]['state'] != 'accepted': raise ValueError()
        return receipt
    except Exception:
        stop('Receipt is unreadable or its fixed input changed; no request was sent.')


def expected_id(receipt, phase):
    if phase == 'upload': return receipt['input']['sha256']
    register_key = receipt['phases']['register']['key']
    library = hashlib.sha256(f'1:studio-glb:{register_key}'.encode()).hexdigest()[:24]
    if phase == 'register': return library
    fit_key = receipt['phases']['fit']['key']
    child_key = 'glbfit_'+hashlib.sha256(f'{library}:{fit_key}'.encode()).hexdigest()[:40]
    return hashlib.sha256(f'1:variant:{child_key}'.encode()).hexdigest()[:24]


def get_json(client, route, *, missing=False):
    try: response = client.get(route)
    except Exception: stop('Lookup did not finish; no automatic retry was made.')
    if missing and response.status_code == 404: return None
    if response.status_code != 200: stop('Lookup was refused or unavailable; no fallback was attempted.')
    try:
        value = response.json()
        if not isinstance(value, dict): raise ValueError()
        return value
    except Exception: stop('Lookup returned an invalid response.')


def verify_body(client, submitted, *, native_hair=None):
    fitted_native = submitted.get('input_mode') == 'fitted_native_hair'
    if fitted_native and native_hair is None:
        stop('Fitted native hair requires the locally validated source bytes.')
    job, version = submitted['body_job'], submitted['body_version']
    route = f'/api/avatar-factory/jobs/{job}/native-parts'
    current = get_json(client, route)
    if current.get('status') != 'review_required' or current.get('version') != version or current.get('origin') == 'uploaded_glb':
        stop('The selected body native version is not currently ready.')
    body = next((a for a in current.get('artifacts', []) if isinstance(a, dict) and a.get('name') == 'body.glb'), {})
    if body.get('sha256') != submitted['body_sha256']:
        stop('The selected body receipt SHA-256 changed.')
    expected_route = f'{route}/{version}/body.glb'
    if body.get('url') != expected_route:
        stop('The named body artifact does not belong to this job and version.')
    try:
        digest = hashlib.sha256(); size = 0
        chunks = [] if fitted_native else None
        with client.stream('GET', expected_route) as response:
            if response.status_code != 200: stop('Named body artifact was refused.')
            for chunk in response.iter_bytes(256*1024):
                size += len(chunk)
                if size > MAX_BYTES: stop('Named body artifact exceeds the bounded size.')
                digest.update(chunk)
                if chunks is not None: chunks.append(chunk)
        if not size or digest.hexdigest() != submitted['body_sha256']:
            stop('Named body bytes do not match the frozen SHA-256.')
        if fitted_native:
            try: validate_native_hair(native_hair, body_content=b''.join(chunks))
            except ValueError: stop('Fitted native hair does not match the frozen body rig or clips.')
    except ImportStopped: raise
    except Exception: stop('Named body verification did not finish.')


def validate_result(receipt, phase, value):
    submitted = receipt['input']; identifier = expected_id(receipt, phase)
    if value.get('id') != identifier: stop('The accepted identifier differs from the saved request.')
    if phase == 'upload':
        expected_rigged = submitted['input_mode'] == 'fitted_native_hair'
        if value.get('bytes') != submitted['bytes'] or value.get('rigged') is not expected_rigged:
            stop('Uploaded asset receipt does not match the validated input.')
    elif phase == 'register':
        if any(value.get(k) != submitted[k] for k in ('name','slot')) or value.get('model_asset') != submitted['sha256']:
            stop('Library record does not match the fixed input.')
        if value.get('source') != {'url':f'/api/studio/glb-assets/{identifier}/source.glb','sha256':submitted['sha256']}:
            stop('Library source does not match the immutable upload.')
    else:
        if (value.get('base_job_id') != submitted['body_job'] or value.get('base_version') != submitted['body_version']
                or value.get('requested_slots') != ['hair'] or value.get('part_name') != submitted['name']):
            stop('Fitted child scope differs from the fixed input.')
        limits = value.get('limits') or {}
        if any(type(limits.get(key)) is not int or limits[key] != 0 for key in ZERO_LIMITS):
            stop('Fitted child does not have a zero-provider budget.')
        if not isinstance(value.get('status'), str) or not re.fullmatch(r'[a-z_]{1,40}',value['status']):
            stop('Fitted child has an invalid status.')
    return identifier


def accept(path, receipt, phase, value):
    identifier = validate_result(receipt, phase, value)
    item = receipt['phases'][phase]
    item.update(state='accepted', id=identifier)
    if phase == 'fit': item['status'] = value['status']
    save(path, receipt)


def lookup(client, receipt, phase):
    identifier = expected_id(receipt, phase)
    if phase == 'upload': route = f'/api/avatar-factory/base-bodies/glb-assets/{identifier}'
    elif phase == 'register': route = f'/api/studio/glb-assets/{identifier}'
    else: route = f'/api/avatar-factory/jobs/{identifier}'
    return get_json(client, route, missing=True)


def run(args, client):
    submitted, content = fixed_input(args)
    path = Path(args.receipt).resolve()
    with receipt_lock(path):
        receipt = read_receipt(path, submitted)
        fitted = receipt['phases'].get('fit')
        if fitted and fitted['state'] == 'accepted':
            value = lookup(client, receipt, 'fit')
            if value is None: stop('Accepted fitted job is missing; no POST was repeated.')
            accept(path, receipt, 'fit', value)
            return receipt
        for phase in PHASES:
            item = receipt['phases'].get(phase)
            if item and item['state'] == 'accepted': continue
            if item:
                if item['state'] == 'rejected': stop('The saved request was definitively refused; no retry was made.')
                if not args.resume: stop('A pending request requires --resume with exactly the same input.')
                value = lookup(client, receipt, phase)
                if value is not None:
                    accept(path, receipt, phase, value); continue
            # Recheck the currently selected named body before every mutation.
            verify_body(client, submitted, native_hair=content if submitted['input_mode'] == 'fitted_native_hair' else None)
            if not item:
                item = {'key':str(uuid.uuid4()),'state':'intent'}
                receipt['phases'][phase] = item
            item['state'] = 'intent'
            save(path, receipt)  # atomic replace + fsync BEFORE every POST
            headers = {'Idempotency-Key':item['key']}
            if phase == 'upload':
                route = '/api/studio/glb-assets/upload'
                headers['Content-Type'] = 'model/gltf-binary'
                body = {'content':content}
            elif phase == 'register':
                route = '/api/studio/glb-assets'
                headers['Content-Type'] = 'application/json'
                body = {'json':{'name':submitted['name'],'slot':'hair','model_asset':submitted['sha256']}}
            else:
                library = expected_id(receipt, 'register')
                route = f'/api/studio/glb-assets/{library}/prepare'
                headers['Content-Type'] = 'application/json'
                body = {'json':{'action':'fit','base_job_id':submitted['body_job'],'base_version':submitted['body_version']}}
            try:
                response = client.post(route, headers=headers, **body)
            except Exception:
                item['state'] = 'uncertain'; save(path, receipt)
                stop('POST outcome is uncertain. Use --resume with the same receipt and input; no automatic retry was made.')
            item['http_status'] = response.status_code
            if response.status_code != (202 if phase == 'fit' else 201):
                item['state'] = 'rejected' if response.status_code in (400,401,403,404,405,409,413,415,422) else 'uncertain'
                save(path, receipt)
                stop('POST was refused or its outcome is uncertain; no fallback or automatic retry was made.')
            try:
                value = response.json()
                if not isinstance(value, dict): raise ValueError()
                accept(path, receipt, phase, value)
            except Exception:
                item['state'] = 'uncertain'; item.pop('id',None); item.pop('status',None); save(path,receipt)
                stop('POST answer was not verified. Use --resume with the same receipt and input.')
        return receipt


def gateway_key(session):
    if session.client('sts', config=Config(connect_timeout=5,read_timeout=20,retries={'total_max_attempts':1})).get_caller_identity()['Account'] != ACCOUNT:
        stop('Unexpected AWS account; no gateway credential was read.')
    client = session.client('secretsmanager',config=Config(connect_timeout=5,read_timeout=20,retries={'total_max_attempts':1}))
    key = client.get_secret_value(SecretId=SECRET)['SecretString'].strip()
    if not re.fullmatch(r'[A-Za-z0-9._~-]{16,256}',key): stop('The existing gateway credential is invalid.')
    return key


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('file','sha256','name','body-job','body-version','body-sha256','receipt'):
        parser.add_argument('--'+option,required=True)
    parser.add_argument('--resume',action='store_true',help='Recover a saved intent using the same request key and input.')
    parser.add_argument('--fitted-native-hair',action='store_true',
        help='Require a rigged native hair GLB bound to the exact named body; preserve its skin and clips.')
    args = parser.parse_args()
    submitted, _ = fixed_input(args)  # reject local mistakes before reading a credential
    read_receipt(Path(args.receipt).resolve(),submitted)
    session = boto3.Session(region_name=REGION)
    key = gateway_key(session)
    with httpx.Client(base_url=ORIGIN,headers={'x-gateway-key':key},follow_redirects=False,trust_env=False,
                      timeout=httpx.Timeout(120,connect=10),verify=True) as client:
        receipt = run(args,client)
    del key
    print(json.dumps({'owner_id':1,'origin':ORIGIN,'phases':receipt['phases'],'provider_calls':0}))


if __name__ == '__main__':
    try: main()
    except ImportStopped as exc:
        print(str(exc),file=sys.stderr); sys.exit(1)
    except Exception:
        print('Import did not finish. Inspect the existing nonsecret receipt; no automatic retry was made.',file=sys.stderr)
        sys.exit(1)
