"""The five frozen expression requests belonging to a character production job."""
from threading import Lock

from src.services.asset_editor import _write_json
from src.services.character_pipeline import PipelineError, now, read_json
from src.services.process_identity import identity, state as process_state
from src.services.object_storage import sha256

_WORKERS = {}
_GUARD = Lock()


def default_contract(prompts=None):
    from src.services.studio_prompts import DEFAULTS
    prompts = DEFAULTS['expression'] if prompts is None else prompts
    names = ['neutral', 'smile', 'cry', 'angry', 'surprise']
    return {'names': names, 'prompts': {name: prompts[name] for name in names},
            'revision': 'default-expressions-v2-managed-ko'}


def saved_expression_valid(directory, expression_id):
    if not expression_id:
        return False
    root = directory/'expressions'/expression_id
    record = read_json(root/'record.json')
    files = record.get('files', {})
    required = {'body.glb', 'model.glb', 'manifest.json'} | {item['file'] for item in record.get('materials', [])}
    required.update(item['base_file'] for item in record.get('materials', []) if item.get('base_file'))
    if 'face.png' in files:
        required.add('face.png')
    if not record.get('materials') or not required <= files.keys():
        return False
    try:
        return all((root/name).is_file() and sha256(root/name) == files[name] for name in required)
    except (FileNotFoundError, ValueError):
        return False


def summary(directory, version=None):
    pipeline = read_json(directory/'pipeline.json')
    from src.services.avatar_expression_reuse import reuse_contract
    if reuse_contract(pipeline):
        return None
    contract = pipeline.get('default_expressions')
    if not contract:
        return None
    record = read_json(directory/'default-expressions.json')
    if version is None:
        version = read_json(directory/'native-parts/current.json').get('version')
    baked = record.get('bodies', {}).get(version, {})
    items = []
    for name in contract['names']:
        generation = record.get('generations', {}).get(name)
        saved = (read_json(directory/'native-parts'/record['source_version']/'expression-generations'/generation/'record.json')
                 if generation else {})
        expression = baked.get(name)
        complete = bool(version and saved_expression_valid(directory/'native-parts'/version, expression))
        items.append({'name': name, 'generation_id': generation, 'expression_id': expression,
                      'status': 'complete' if complete else saved.get('status', 'pending'),
                      'applied': complete, 'error': saved.get('error')})
    complete = sum(item['applied'] for item in items)
    busy = record.get('status') == 'running' and process_state(record.get('process')) != 'exited'
    selection = read_json(directory/'native-parts'/version/'expressions/selection.json') if version else {}
    selected = selection.get('expression_id')
    return {'items': items, 'completed': complete, 'total': len(items), 'busy': busy,
            'status': 'complete' if complete == len(items) else 'running' if busy else 'paused',
            'error': record.get('error'), 'default': 'neutral', 'selected': selected,
            'default_selected': bool(selected and selected == baked.get('neutral'))}


def execute(factory, owner, job, version, *, retry_blocked=False):
    """Only called by an admitted production/resume command, never by a GET.

    retry_blocked is an explicit operator run: an expression whose request was refused
    or left unconfirmed is requested again under a new key, keeping the old receipt.
    """
    from src.services.avatar_expression_generation import AvatarExpressionGeneration
    from src.services.avatar_expressions import AvatarExpressions

    directory = factory.directory(owner, job)
    pipeline = read_json(directory/'pipeline.json')
    # A part-only/refit intent freezes the existing faces and never falls back
    # to the original job's paid default-expression generation contract.
    from src.services.avatar_expression_reuse import reuse_contract
    if reuse_contract(pipeline):
        return
    contract = pipeline.get('default_expressions')
    if not contract:
        return
    with _GUARD:
        lock = _WORKERS.setdefault(str(directory), Lock())
    if not lock.acquire(blocking=False):
        return
    path = directory/'default-expressions.json'
    try:
        record = read_json(path) or {'source_version': version, 'generations': {}, 'bodies': {}, 'created_at': now()}
        record.setdefault('source_version', version)
        record.setdefault('generations', {})
        record.setdefault('bodies', {})
        record.update(status='running', process=identity(), error=None, updated_at=now())
        _write_json(path, record)
        source = AvatarExpressionGeneration(factory, owner, job, record['source_version'])
        target = AvatarExpressions(factory, owner, job, version)
        baked = record['bodies'].setdefault(version, {})
        errors = []
        for name in contract['names']:
            try:
                # Reassembly reuses this job's original five images even if the body version changes.
                generation = record['generations'].get(name)
                if not generation:
                    item, _ = source.create(f'default-expression-{name}-v1', {
                        'name': name, 'prompt': contract['prompts'][name]})
                    generation = item['id']
                    record['generations'][name] = generation
                    _write_json(path, record)
                item = source.get(generation)
                if retry_blocked and item['status'] != 'complete' and not item['can_resume'] and item['status'] not in ('accepted', 'running'):
                    previous = record.setdefault('previous_generations', {}).setdefault(name, [])
                    previous.append(generation)
                    item, _ = source.create(f'default-expression-{name}-v1-r{len(previous)}', {
                        'name': name, 'prompt': contract['prompts'][name]})
                    generation = item['id']
                    record['generations'][name] = generation
                    _write_json(path, record)
                if item['status'] != 'complete' and item['can_resume']:
                    _, admitted = source.resume(generation)
                    if admitted:
                        source.execute(generation)
                    item = source.get(generation)
                if item['status'] != 'complete':
                    errors.append(item.get('error') or f'{name}: 표정 이미지 수신 대기')
                    continue
                if not saved_expression_valid(directory/'native-parts'/version, baked.get(name)):
                    expression = target.save_generated(source.artifact(generation, 'face.png'), name)
                    baked[name] = expression['id']
                    record['updated_at'] = now()
                    _write_json(path, record)
                if name == 'neutral':
                    selection = target.listing()
                    if selection['revision'] == '0':
                        try:
                            target.select(baked[name], '0')
                        except PipelineError as exc:
                            if exc.code != 'revision_conflict':
                                raise
            except Exception as exc:
                errors.append(exc.message if isinstance(exc, PipelineError) else f'{name}: 표정 텍스처 저장 중단')
                # Finished expressions remain usable while the other requests are attempted.
        # The same local failure for several expressions is reported once.
        record.update(status='paused' if errors else 'complete', error=' / '.join(dict.fromkeys(errors)) or None, updated_at=now())
        _write_json(path, record)
    except Exception as exc:
        record = read_json(path)
        record.update(status='paused', error=exc.message if isinstance(exc, PipelineError) else '기본 표정 처리 중단', updated_at=now())
        _write_json(path, record)
    finally:
        lock.release()
