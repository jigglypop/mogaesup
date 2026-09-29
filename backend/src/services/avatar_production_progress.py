"""Progress is derived from durable receipts, never elapsed-time animation."""
from src.services.character_pipeline import read_json


def production_progress(directory, job):
    parts = job.get('parts', [])
    images = [image for part in parts for image in (list(part.get('views', {}).values()) or [{'status': part.get('image_status')}])]
    if job.get('input_kind') == 'glb':
        images = []
    direct_import = job.get('input_kind') == 'glb' and job.get('input', {}).get('import_mode') == 'register'
    image_done = sum(i.get('status') == 'succeeded' for i in images)
    image_received = sum(i.get('status') in ('received', 'succeeded', 'qc_failed') for i in images)
    image_failed = any(i.get('status') in ('not_sent', 'rejected', 'failed', 'submission_uncertain') for i in images)
    models_done = sum(p.get('model_status') == 'ready' for p in parts)
    # Provider 100% means generation finished; local download still has to succeed.
    model_fraction = sum(1 if p.get('model_status') == 'ready' else max(0, min(99, p.get('progress') or 0))/100 for p in parts)
    model_failed = any(p.get('model_status') in ('FAILED', 'CANCELED', 'submission_uncertain', 'submission_rejected',
                                                   'submission_not_sent') for p in parts)
    flow = job.get('character_flow', {})
    worker = read_json(directory/'meshy/worker.json'); rig = read_json(directory/'meshy/character.json')
    delivery = read_json(directory/'meshy/delivery.json')
    pointer = read_json(directory/'native-parts/current.json')
    native_dir = directory/'native-parts'/pointer['version'] if pointer else None
    native = read_json(native_dir/'record.json') if native_dir else {}
    native_ready = native.get('status') == 'review_required'
    incomplete = {p['slot']: p for p in native.get('result', {}).get('incomplete_parts', [])}
    job['assembly_version'] = pointer.get('version') if native_ready else None
    # An uploaded GLB registered without assembly cannot be the body of new parts.
    job['assembly_origin'] = native.get('result', {}).get('origin') if native_ready else None
    # Reuse the saved assembly receipt already read for progress. Gallery cards
    # should not each request the whole native-parts state to find their GLB.
    job['assembly_artifacts'] = [
        {'name': name, 'sha256': sha256,
         'url': f'/api/avatar-factory/jobs/{job["id"]}/native-parts/{pointer["version"]}/{name}'}
        for name, sha256 in native.get('files', {}).items() if name.endswith('.glb')
    ] if native_ready else []
    pipeline = read_json(directory/'pipeline.json')
    reused_parts = pipeline.get('native_part_reuse', {}).get('parts', {})
    for part in parts:
        part['reused'] = part['slot'] in reused_parts or (part['slot'] == 'body' and bool(pipeline.get('base_body')))
        part['assembly_status'] = ('failed' if part['slot'] in incomplete else 'complete' if native_ready else
                                   'running' if native.get('status') in ('accepted', 'running') and flow.get('busy') else
                                   'failed' if native.get('status') in ('failed', 'qc_failed') else 'pending')
        if part['slot'] in incomplete:
            part['fit_status'] = incomplete[part['slot']].get('status')
    frozen = bool(job.get('production_spec')) and not direct_import
    steps = []
    fractions = []
    def add(key, label, done, total, fraction=None, active=False, failed=False):
        state = 'complete' if total and done == total else 'running' if active else 'blocked' if failed else 'pending'
        amount = done if fraction is None else fraction
        fractions.append(max(0, min(total, amount)))
        steps.append({'id': key, 'label': label, 'state': state, 'completed': done, 'total': total,
                      'percent': min(99 if done != total else 100, round(100*amount/total)) if total else None})
    if frozen:
        add('spec', '공통 규격', 1, 1)
    reference = job.get('reference_preparation')
    if reference:
        reference_status = reference.get('status')
        reference_views = list(reference.get('views', {}).values()) or [reference]
        add('reference', '공통 규격 원본', sum(view.get('status') == 'succeeded' for view in reference_views), len(reference_views),
            active=flow.get('busy') and flow.get('stage') in ('reference', 'queued'),
            failed=reference_status in ('not_sent', 'rejected', 'failed', 'submission_uncertain'))
    view_count = len(job.get('production_spec', {}).get('generated_views', []))
    image_label = ('정면·후면·좌우면' if view_count == 4 else
                   '정면·측면·후면' if view_count == 3 else '정면·측면' if frozen else '이미지')
    if job.get('input_kind') != 'glb':
        add('images', image_label, image_done, len(images),
            active=flow.get('busy') and flow.get('stage') in ('images', 'queued'), failed=image_failed)
    add('models', '3D 파츠', models_done, len(parts), fraction=model_fraction,
        active=flow.get('busy') and flow.get('stage') == 'models', failed=model_failed)
    rig_done = bool(delivery) and worker.get('status') == 'complete'
    rig_fraction = max(0, min(99, rig.get('progress') or 0))/100 if rig.get('stage') == 'rigging' and rig.get('status') == 'IN_PROGRESS' else 0
    if not direct_import:
        add('rig', '리깅·동작', int(rig_done), 1, fraction=1 if rig_done else rig_fraction,
            active=flow.get('busy') and flow.get('stage') == 'rig', failed=not flow.get('busy') and bool(worker.get('error')))
    add('assemble', 'GLB 등록' if direct_import else '피팅·조립', int(native_ready and not incomplete), 1,
        active=flow.get('busy') and flow.get('stage') == 'assemble',
        failed=bool(incomplete) or native.get('status') in ('failed', 'qc_failed'))
    expressions = job.get('default_expressions')
    if expressions:
        add('expressions', '기본 표정 텍스처', expressions['completed'], expressions['total'],
            active=expressions['busy'], failed=bool(expressions['error']))
    from src.services.avatar_expression_reuse import expression_reuse_state
    reused_expressions = expression_reuse_state(directory)
    if reused_expressions and reused_expressions['total']:
        add('expressions', '저장된 표정 적용', reused_expressions.get('completed', 0), reused_expressions['total'],
            active=flow.get('busy') and reused_expressions['status'] == 'running',
            failed=reused_expressions['status'] == 'paused')
    # A stopped worker must not look like it is still generating a pending part.
    if not flow.get('busy') and flow.get('status') in ('paused', 'blocked'):
        stopped = next((s for s in steps if s['id'] == flow.get('stage') and s['state'] != 'complete'), None)
        if stopped and not any(s['state'] == 'blocked' for s in steps):
            stopped['state'] = 'blocked'
    active = next((s for s in steps if s['state'] == 'blocked'), None) or next((s for s in steps if s['state'] == 'running'), None)
    if not active:
        active = next((s for s in steps if s['state'] != 'complete'), steps[-1])
    total = sum(s['total'] for s in steps)
    completed = sum(s['completed'] for s in steps)
    return {'steps': steps, 'completed': completed, 'total': total,
            'percent': min(100 if native_ready and all(s['state'] == 'complete' for s in steps) else 99,
                           round(100*sum(fractions)/total)) if total else 0, 'current': active['id'],
            'images_received': image_received, 'images_total': len(images),
            'status': flow.get('status', job['status']), 'message': flow.get('message', job['progress']['message']),
            'updated_at': job.get('updated_at', job.get('created_at')), 'spec_id': job.get('production_spec', {}).get('id')}
