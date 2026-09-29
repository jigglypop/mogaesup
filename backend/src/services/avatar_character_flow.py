"""Continue one photo-to-character job through its final local assembly."""
import logging

from src.services.asset_editor import _write_json
from src.services.character_pipeline import PipelineError, read_json
from src.services.meshy_status import saved_problem

LOGGER = logging.getLogger(__name__)


def character_flow(directory, job):
    """Summarize saved receipts only; GET must never poll a paid provider."""
    from src.services.avatar_stage_resume import active_run, current_run

    progress = job['progress']
    problem = None
    busy = job['status'] in ('pipeline_queued', 'pipeline_running', 'accepted', 'running')
    status = 'running' if busy else 'paused'
    stage, message = progress['stage'], job.get('error') or progress['message']
    if job['status'] == 'review_required':
        pointer = read_json(directory/'native-parts/current.json')
        native = read_json(directory/'native-parts'/pointer['version']/'record.json') if pointer else {}
        worker = read_json(directory/'meshy/worker.json')
        busy = active_run(native) or active_run(worker)
        problem = saved_problem(directory/'meshy')
        blocked = bool(problem)
        if native.get('status') == 'review_required' and not busy:
            status, stage, message = 'review_required', 'complete', '조립 완료'
            if native.get('result', {}).get('origin') == 'uploaded_glb':
                message = 'GLB 등록 완료'
            job['next_actions'] = []
            job['error'] = None
            from src.services.avatar_expression_reuse import expression_reuse_state
            expression_reuse = expression_reuse_state(directory)
            if expression_reuse and expression_reuse['status'] != 'complete':
                busy = expression_reuse['busy']
                status, stage = ('running' if busy else 'paused'), 'expressions'
                message = expression_reuse.get('error') or ('기존 표정 적용 중' if busy else '기존 표정 적용 대기')
                job['next_actions'] = [{'id': 'resume', 'enabled': not busy, 'reason': '표정 적용 중' if busy else None}]
            expressions = job.get('default_expressions')
            if stage == 'complete' and expressions and expressions['status'] != 'complete':
                busy = expressions['busy']
                status, stage = ('running' if busy else 'paused'), 'expressions'
                message = expressions['error'] or f"기본 표정 텍스처 {expressions['completed']}/{expressions['total']}"
                job['next_actions'] = [{'id': 'resume', 'enabled': not busy, 'reason': message if busy else None}]
            incomplete = native.get('result', {}).get('incomplete_parts', [])
            if incomplete and not busy:
                status, stage = 'paused', 'assemble'
                slots = ', '.join({'top': '상의', 'bottom': '하의'}.get(p['slot'], p['slot']) for p in incomplete)
                message = f'{slots} 피팅 기준점 보정 필요'
                job['next_actions'] = []
        else:
            stage = 'assemble' if active_run(native) or worker.get('status') == 'complete' else 'rig'
            status = 'running' if busy else 'blocked' if blocked or native.get('status') in ('failed', 'qc_failed') else 'paused'
            message = ('파츠 조립 중' if stage == 'assemble' else '몸 리깅·동작 수신 중') if busy else (
                ('조립 재개 필요' if native.get('status') == 'qc_failed' else native.get('error')) or worker.get('error') or job.get('error') or
                ('기존 제공자 응답 확인 필요' if blocked else '저장된 작업에서 이어가기 대기'))
            if busy and stage == 'rig' and worker.get('origin') == 'rig_transfer':
                message = '저장된 골격·동작 연결 중'
            job['next_actions'] = [{'id': 'resume', 'enabled': not busy and not blocked,
                'reason': message if busy or blocked else None}]
            if native.get('status') == 'qc_failed':
                job['error'] = message
    elif not busy:
        status = 'paused' if any(a['id'] == 'resume' and a['enabled'] for a in job['next_actions']) else 'blocked'
    operation = current_run(directory)
    if active_run(operation):
        busy, status = True, 'running'
        if operation['status'] == 'accepted' or stage in ('complete', 'queued'):
            stage = operation['stage']
            message = {'images': '이미지부터 이어서 실행', 'models': '3D 파츠부터 이어서 실행',
                       'rig': '리깅·동작부터 이어서 실행', 'assemble': '피팅·조립부터 실행',
                       'expressions': '기본 표정 텍스처부터 이어서 실행'}[stage]
        job['next_actions'] = []
    elif (operation.get('status') == 'paused' and operation.get('error') and not busy
          and stage != 'complete' and not (job['status'] == 'review_required' and worker.get('origin') == 'rig_transfer')):
        status, stage, message = 'paused', operation['stage'], operation['error']
    if problem and not busy and native.get('status') != 'review_required':
        message = worker.get('error') if worker.get('origin') == 'rig_transfer' and worker.get('error') else problem['message']
        status, stage = 'blocked', 'rig'
        job['next_actions'] = [{'id': 'resume', 'enabled': False, 'reason': message}]
    return {'status': status, 'stage': stage, 'message': message, 'busy': busy}


def assemble_character(factory, owner, job_id):
    from src.services.avatar_native_parts import AvatarNativeParts
    directory = factory.directory(owner, job_id)
    _write_json(directory / 'output/progress.json', {'stage': 'assemble', 'message': '파츠 조립 중'})
    service = AvatarNativeParts(factory)
    try:
        _, created = service.start(owner, job_id)
        if created:
            service.execute(owner, job_id)
        state = service.get(owner, job_id)
        if state['status'] == 'review_required':
            from src.services.avatar_glb_bodies import publish_import_views
            publish_import_views(factory, owner, job_id, state['version'])
            from src.services.avatar_expression_reuse import reuse_saved_expressions
            reuse_saved_expressions(factory, owner, job_id, state['version'])
            if state.get('incomplete_parts'):
                _write_json(directory/'output/progress.json', {'stage': 'assemble', 'message': '일부 파츠 피팅 기준점 보정 필요'})
                record = read_json(directory/'job.json')
                record['error'] = '일부 파츠 피팅 기준점 보정 필요'
                _write_json(directory/'job.json', record)
                return
            from src.services.avatar_expression_pipeline import execute, summary
            execute(factory, owner, job_id, state['version'])
            expressions = summary(directory, state['version'])
            error = expressions.get('error') if expressions and expressions['status'] != 'complete' else None
            if expressions and expressions['status'] != 'complete':
                error = error or '기본 표정 텍스처 처리 대기'
            _write_json(directory / 'output/progress.json', {
                'stage': 'expressions' if error else 'complete', 'message': error or '조립 완료'})
        else:
            error = state.get('error') or '조립 작업을 이어서 확인해야 합니다.'
    except Exception as exc:
        LOGGER.exception('Character assembly stopped job=%s', job_id)
        error = (exc.message if isinstance(exc, PipelineError) else
                 f'파츠 조립 중단 ({type(exc).__name__}) · 생성한 파츠와 몸·동작은 보존했습니다.')
    record = read_json(directory / 'job.json')
    record['error'] = error
    _write_json(directory / 'job.json', record)


def continue_character(factory, owner, job_id):
    from src.services.avatar_meshy import AvatarMeshy
    job = factory.get(owner, job_id)
    if job.get('production_mode') != 'character_parts' or job['status'] != 'review_required':
        return
    directory = factory.directory(owner, job_id)
    record = read_json(directory / 'job.json')
    record['auto_assemble'] = True
    _write_json(directory / 'job.json', record)
    if (read_json(directory / 'meshy/worker.json').get('status') == 'complete'
            or read_json(directory / 'meshy/delivery.json').get('origin') == 'transferred_meshy_rig'):
        assemble_character(factory, owner, job_id)
    else:
        rig_source = (read_json(directory/'pipeline.json').get('base_body_setup') or {}).get('rig_source')
        if rig_source:
            from src.services.avatar_rig_transfer import AvatarRigTransfer
            transfer = AvatarRigTransfer(factory)
            _, request_id = transfer.start(owner, job_id, rig_source['job_id'], rig_source['version'],
                'base-body-rig-'+job_id, during_pipeline=True)
            if request_id:
                transfer.execute(owner, job_id, request_id)
            return
        provider = AvatarMeshy(factory)
        provider.start(owner, job_id)
        provider.execute(owner, job_id)
