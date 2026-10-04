"""Re-bake saved expression faces onto a single-part variant without provider I/O."""
from src.services.asset_editor import _write_json
from src.services.avatar_factory import digest
from src.services.avatar_expressions import AvatarExpressions
from src.services.avatar_expression_pipeline import saved_expression_valid
from src.services.character_pipeline import PipelineError, now, read_json
from src.services.object_storage import copy_file, publish_checkpoint
from src.services.process_identity import identity as process_identity
from src.services.run_lock import WorkerLocks, final_write, worker_alive

# The re-bake worker of each job directory that runs in this process.
_WORKERS = WorkerLocks()


def reuse_contract(pipeline):
    """The saved-expression snapshot of a refit, or None when it froze nothing.

    An empty snapshot (for example after the face bake never succeeded) must not
    hide the job's own default expressions, whose images are already generated.
    """
    contract = pipeline.get('expression_reuse')
    return contract if contract and contract.get('expressions') else None


def snapshot_saved_expressions(factory, owner, source_job, source_version, target_directory):
    """Freeze reusable face inputs and the selected expression at acceptance."""
    source_root = factory.directory(owner, source_job)/'native-parts'/source_version/'expressions'
    selection = read_json(source_root/'selection.json')
    selected = selection.get('expression_id')
    inputs = target_directory/'expression-inputs'
    expressions = []
    for source_record_path in sorted(source_root.glob('*/record.json')):
        source_id = source_record_path.parent.name
        source_record = read_json(source_record_path)
        expected = source_record.get('files', {}).get('face.png')
        face = source_record_path.parent/'face.png'
        if not expected:
            if source_id == selected:
                raise PipelineError('selected_expression_missing', '선택한 기존 표정 원본을 확인할 수 없습니다.', 409)
            continue
        if not face.is_file() or digest(face) != expected:
            raise PipelineError('saved_expression_missing', '저장된 기존 표정 원본을 확인할 수 없습니다.', 409)
        frozen_name = f'{source_id}.png'
        inputs.mkdir(parents=True, exist_ok=True)
        copy_file(face, inputs/frozen_name)
        expressions.append({'source_id': source_id, 'name': source_record['name'],
                            'file': frozen_name, 'sha256': expected})
    return {'source_job_id': source_job, 'source_version': source_version,
            'source_selection_revision': selection.get('revision', '0'),
            'selected_source_id': selected, 'expressions': expressions}


def reuse_running(directory):
    """(expression-reuse.json of the job `directory`, whether its worker still runs). One this process started runs
    only while it holds its worker lock: a worker whose last save failed leaves running behind, and that must not hold
    the job until a restart."""
    held = _WORKERS.busy(str(directory))
    record = read_json(directory/'expression-reuse.json')
    return record, record.get('status') == 'running' and worker_alive(record, held or _WORKERS.busy(str(directory)))


def reuse_saved_expressions(factory, owner, job, target_version):
    directory = factory.directory(owner, job)
    if not _WORKERS.acquire(str(directory)):
        return read_json(directory/'expression-reuse.json')
    try:
        return _reuse_saved_expressions(factory, owner, job, target_version)
    finally:
        _WORKERS.release(str(directory))


def _reuse_saved_expressions(factory, owner, job, target_version):
    directory = factory.directory(owner, job)
    contract = reuse_contract(read_json(directory/'pipeline.json'))
    if not contract:
        return None
    source_job = contract['source_job_id']
    source_version = contract['source_version']
    source_selected = contract.get('selected_source_id')
    path = directory/'expression-reuse.json'
    record = read_json(path)
    identity = {'source_job_id': source_job, 'source_version': source_version,
                'target_version': target_version,
                'source_selection_revision': contract.get('source_selection_revision', '0')}
    target_directory = directory/'native-parts'/target_version
    if (record.get('status') == 'complete'
            and all(record.get(key) == value for key, value in identity.items())
            and all(saved_expression_valid(target_directory, record.get('expressions', {}).get(item['source_id']))
                    for item in contract.get('expressions', []))):
        return record

    record = {**identity, 'status': 'running', 'error': None, 'process': process_identity(),
              'expressions': record.get('expressions', {}) if record.get('target_version') == target_version else {},
              'updated_at': now()}

    def save():
        _write_json(path, record)
        publish_checkpoint(path)

    save()
    target = AvatarExpressions(factory, owner, job, target_version)
    try:
        for source_expression in contract.get('expressions', []):
            source_id = source_expression['source_id']
            if saved_expression_valid(target_directory, record['expressions'].get(source_id)):
                continue
            face = directory/'expression-inputs'/source_expression['file']
            if not face.is_file() or digest(face) != source_expression['sha256']:
                raise PipelineError('saved_expression_missing', '고정한 기존 표정 원본을 확인할 수 없습니다.', 409)
            item = target.save_generated(face, source_expression['name'])
            record['expressions'][source_id] = item['id']
            record['updated_at'] = now()
            _write_json(path, record)
            publish_checkpoint(path)
        if source_selected:
            target_selected = record['expressions'].get(source_selected)
            if not target_selected:
                raise PipelineError('selected_expression_missing', '선택한 기존 표정을 새 조립본에 적용할 수 없습니다.', 409)
            selection = target.listing()
            if selection['revision'] == '0':
                target.select(target_selected, '0')
        record.update(status='complete', selected=record['expressions'].get(source_selected),
                      completed=len(record['expressions']), error=None, updated_at=now())
        final_write(save, 'expression reuse record')
        return record
    except Exception as exc:
        record.update(status='paused', error=(exc.message if isinstance(exc, PipelineError) else '기존 표정을 새 조립본에 적용하지 못했습니다.'),
                      updated_at=now())
        # A storage blip that stopped the worker must not also leave it running.
        final_write(save, 'expression reuse record')
        raise


def expression_reuse_state(directory):
    contract = reuse_contract(read_json(directory/'pipeline.json'))
    if not contract:
        return None
    record, running = reuse_running(directory)
    version = read_json(directory/'native-parts/current.json').get('version')
    if record.get('target_version') != version:
        record = {}
    return {**(record or {'status': 'pending', 'error': None, 'completed': 0}),
            'busy': bool(running and record.get('process')),
            'total': len(contract.get('expressions', []))}
