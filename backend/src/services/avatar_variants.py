"""New part versions on an immutable, already assembled body. No paid body/rig job."""
from copy import deepcopy
import hashlib
import json
import os
import re
import subprocess

from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, _QUEUE, digest
from src.services.avatar_image_pipeline import AvatarImagePipeline, capabilities
from src.services.avatar_fitting_management import FittingManagement, body_facts
from src.services.avatar_native_parts import AvatarNativeParts
from src.services.avatar_production_spec import production_spec, seal_production_spec
from src.services.avatar_fit_profiles import normalize_fit_profile, reject_generation_fit_profile
from src.services.avatar_image_prompts import DEFAULT_DESIGN_PROMPTS
from src.services.avatar_reference_preparation import initial_state as initial_reference_state, uses_legacy_side_pose
from src.services.avatar_openai_images import DEFAULT_BASE
from src.services.avatar_equipment import NATIVE_EQUIPMENT as EQUIPMENT, equipment_spec
from src.services.character_parts import blender_executable, blender_process, stop_process
from src.services.character_pipeline import PipelineError, now, read_json, request_job_id, require_bucket, require_request_key
from src.services.model_providers import base_url
from src.services.object_storage import StoredPath as Path, WorkspaceUploadError, copy_file, copy_tree, local_workspace
from src.services.process_identity import identity, state as process_state
from src.services.studio_library import StudioLibrary
from src.services.studio_prompts import StudioPrompts

VARIANT_SLOTS = ('hair', 'hat', 'top', 'bottom', 'shoes', *EQUIPMENT)


def requested_hair_length(payload):
    """Explicit length wins; a new design can override the old art's length."""
    selected = payload['hair_length']
    if selected != 'source' or 'hair' not in payload['slots']:
        return selected
    description = payload.get('descriptions', {}).get('hair', '').lower()
    short = bool(re.search(r'숏\s*컷|쇼트\s*컷|짧은\s*(머리|헤어)|단발|\b(short|pixie|bob|buzz\s*cut)\b', description))
    long = bool(re.search(r'롱\s*(헤어|컷)|긴\s*(머리|헤어)|장발|\b(long|waist[- ]length)\b', description))
    # Conflicting/missing cues retain source proportions instead of guessing.
    return ('short' if short else 'long') if short != long else selected


def requested_bottom_kind(payload):
    selected = payload.get('bottom_kind') or 'source'
    if selected not in ('source', 'pants', 'skirt'):
        raise PipelineError('invalid_bottom_kind', '하의 종류를 다시 선택하세요.', 422)
    if selected != 'source':
        return selected
    description = payload.get('descriptions', {}).get('bottom', '').lower()
    skirt = bool(re.search(r'치마|스커트|\bskirt\b', description))
    pants = bool(re.search(r'바지|팬츠|\b(pants|trousers|shorts|jeans)\b', description))
    return ('skirt' if skirt else 'pants') if skirt != pants else 'source'


class AvatarVariants:
    def __init__(self, factory):
        self.factory = factory

    def create_single_part(self, owner, key, payload, *, frozen_context=None):
        """Accept one saved prompt-backed part replacement.

        Without a description, create() freezes the owner's prompt-library value into the accepted
        job; a description (a garment's own design brief) takes its place for this part only. Both
        keep the existing idempotency and recovery behavior.
        """
        slot = payload['slot']
        variant = {
            'base_job_id': payload['base_job_id'],
            'base_version': payload['base_version'],
            'slots': [slot],
            'hair_length': payload.get('hair_length', 'source'),
            'bottom_kind': payload.get('bottom_kind', 'source'),
            'descriptions': {},
            'single_part': True,
        }
        if 'fit_profile' in payload:
            if slot not in ('top', 'bottom'):
                raise PipelineError('invalid_fit_profile', '상의와 하의에만 의상 피팅을 적용할 수 있습니다.', 422)
            variant['fit_profiles'] = {slot: payload['fit_profile']}
        if 'view_mode' in payload:
            variant['view_mode'] = payload['view_mode']
        if 'meshy_options' in payload:
            variant['meshy_options'] = payload['meshy_options']
        for field in ('uploaded_views', 'uploaded_model', 'part_name', 'model_provider'):
            if payload.get(field):
                variant[field] = payload[field]
        if (payload.get('description') or '').strip():
            variant['descriptions'] = {slot: payload['description'].strip()}
        if payload.get('part_method'):
            variant['part_methods'] = {slot: payload['part_method']}
        if payload.get('redraw') is not None:
            variant['redraw'] = payload['redraw']
        return self.create(owner, key, variant, frozen_context=frozen_context)

    def _warm_body(self, owner, payload):
        """Parse the base body before the process lock is taken, so the checks under it read the result from memory.
        What is wrong with the base is reported by those checks; a failure here is not."""
        try:
            body_file = self.factory.directory(owner, payload['base_job_id'])/'native-parts'/payload['base_version']/'body.glb'
            body_facts(body_file, digest(body_file))
        except Exception:
            pass

    def create(self, owner, key, payload, *, photo_input=None, frozen_context=None):
        require_request_key(key)
        require_bucket()
        slots = payload['slots']
        if not slots or len(set(slots)) != len(slots) or not set(slots) <= set(VARIANT_SLOTS):
            raise PipelineError('invalid_slots', '생성할 파츠를 선택하세요.', 422)
        if payload['hair_length'] not in ('source', 'short', 'long'):
            raise PipelineError('invalid_hair_length', '머리 길이를 선택하세요.', 422)
        if not set(payload.get('descriptions', {})) <= set(slots):
            raise PipelineError('invalid_description', '선택한 파츠의 설명만 입력하세요.', 422)
        submitted_fit_profiles = (photo_input if photo_input is not None else payload).get('fit_profiles') or {}
        if not isinstance(submitted_fit_profiles, dict) or not set(submitted_fit_profiles) <= {'top', 'bottom'}:
            raise PipelineError('invalid_fit_profile', 'fit_profiles에는 top과 bottom만 입력할 수 있습니다.', 422)
        if (not payload.get('single_part')
                and any(not payload.get('descriptions', {}).get(slot, '').strip() for slot in slots if slot in EQUIPMENT)):
            raise PipelineError('equipment_description_required', '무기·도구·안경의 디자인을 입력하세요.', 422)
        namespace = 'image' if photo_input is not None else 'variant'
        job_id = request_job_id(owner, namespace, key)
        fingerprint = hashlib.sha256(json.dumps(photo_input if photo_input is not None else payload, sort_keys=True).encode()).hexdigest()
        target = self.factory.directory(owner, job_id)
        if frozen_context is None and not read_json(target/'job.json'):
            # A batch child was covered when its batch was accepted; a replay returns its job.
            from src.services.meshy_status import require_credits
            from src.services.avatar_part_methods import resolve as resolve_methods, needs_provider
            from src.services.model_providers import resolve_provider
            source_input = photo_input if photo_input is not None else payload
            estimate = resolve_methods(slots, source_input.get('part_methods'),
                uploaded_views=bool(payload.get('uploaded_views')), uploaded_model=bool(payload.get('uploaded_model')),
                worn_redraw=bool((payload.get('redraw') or {}).get('worn')))
            if resolve_provider(source_input.get('model_provider')) == 'meshy':
                require_credits(0 if payload.get('uploaded_model') else sum(needs_provider(m) for m in estimate.values()))
        if not read_json(target/'job.json'):
            self._warm_body(owner, payload)
        # Copies of stored files (one request each in S3) are made after every check has passed and without the
        # process lock; the lock is taken again only to accept the job.
        staged = []
        with _LOCK:
            prior = read_json(target/'job.json')
            if prior:
                if prior['fingerprint'] != fingerprint:
                    raise PipelineError('idempotency_conflict', '같은 요청의 입력이 변경되었습니다.', 409)
                return self.factory.get(owner, job_id), False
            # Batch acceptance seals these values before any child is dispatched.
            # This keyword is internal and is never read from browser input.
            prompt_snapshot = (deepcopy(frozen_context['prompt_snapshot']) if frozen_context
                               else StudioPrompts(self.factory, owner).snapshot())
            from src.services.meshy_options import freeze_options
            meshy_options = (deepcopy(frozen_context['meshy_options']) if frozen_context else
                             {slot: freeze_options(self.factory, owner, (photo_input or payload).get('meshy_options'),
                                                   slot, prompt_snapshot['meshy_texture'], shared=photo_input is not None)
                              for slot in slots})
            uploaded_views = payload.get('uploaded_views')
            uploaded_model = payload.get('uploaded_model')
            redraw = payload.get('redraw')
            if redraw is not None:
                if slots != ['hair'] or not uploaded_views or uploaded_model:
                    raise PipelineError('invalid_hair_redraw', '헤어 원본 3뷰를 선택한 뒤 고화질 다시 그리기를 사용하세요.', 422)
                from src.services.avatar_hair_redraw import contract
                redraw = contract(**redraw)
                if frozen_context and frozen_context.get('hair_redraw_contract'):
                    frozen_redraw = frozen_context['hair_redraw_contract']
                    if any(frozen_redraw.get(field) != redraw[field] for field in ('notes', 'source_side_facing')):
                        raise PipelineError('redraw_changed', '접수한 헤어 보정 입력이 변경되었습니다.', 409)
                    redraw = deepcopy(frozen_redraw)
            from src.services.avatar_part_methods import resolve as resolve_methods, needs_provider, needs_key_render
            from src.services.model_providers import resolve_provider
            source_input = photo_input if photo_input is not None else payload
            part_methods = resolve_methods(slots, source_input.get('part_methods'),
                uploaded_views=bool(uploaded_views), uploaded_model=bool(uploaded_model),
                worn_redraw=bool(redraw and redraw.get('worn')))
            model_provider = (frozen_context or {}).get('model_provider') or resolve_provider(source_input.get('model_provider'))
            if uploaded_views and (not payload.get('single_part') or set(uploaded_views) != {'front', 'side', 'back'}):
                raise PipelineError('invalid_views', '단일 파츠의 정면·측면·후면 원본이 필요합니다.', 422)
            if uploaded_model:
                if not payload.get('single_part') or uploaded_views or set(uploaded_model) != {'asset_id', 'path', 'sha256'}:
                    raise PipelineError('invalid_model', '업로드한 단일 GLB 파츠를 다시 선택해 주세요.', 422)
                model_path = Path(uploaded_model['path'])
                if (not re.fullmatch(r'[a-f0-9]{64}', uploaded_model['asset_id'])
                        or uploaded_model['sha256'] != uploaded_model['asset_id']
                        or not model_path.is_file() or digest(model_path) != uploaded_model['sha256']):
                    raise PipelineError('source_changed', '등록한 GLB 원본을 확인할 수 없습니다.', 409)
            available = capabilities()
            if not available['blender_available']:
                raise PipelineError('provider_unavailable', 'Blender 연결 설정을 확인해 주세요.', 503)
            provider_needed = not uploaded_model and any(needs_provider(m) for m in part_methods.values())
            provider_ready = available.get(f'{model_provider}_configured', False)
            if not uploaded_model and not ((provider_ready or not provider_needed)
                    and ((bool(uploaded_views) and not redraw) or available['image_configured'])):
                raise PipelineError('provider_unavailable', '생성 서비스 연결을 확인하세요.', 503)
            base_id = payload['base_job_id']
            base = self.factory.get(owner, base_id)
            library = StudioLibrary(self.factory, owner)
            metadata = library.metadata()
            if (metadata['parts'].get(f'{base_id}:body', {}).get('deleted')
                    or library.is_job_deleted(base, metadata)):
                raise PipelineError('body_deleted', '삭제한 기본 몸은 갤러리 휴지통에서 복원한 뒤 선택하세요.', 409)
            native_service = AvatarNativeParts(self.factory)
            native = (native_service.get(owner, base_id, version=payload['base_version'])
                      if photo_input is not None or frozen_context is not None else native_service.get(owner, base_id))
            if native.get('status') != 'review_required' or native.get('version') != payload['base_version']:
                raise PipelineError('base_changed', '저장된 기본 몸 버전을 다시 선택하세요.', 409)
            if native.get('origin') == 'uploaded_glb':
                raise PipelineError('body_preparation_required',
                    '리깅된 GLB는 피팅·조립부터 실행해 기준 몸을 준비하세요. 골격이 없으면 새 리깅 후 등록을 선택하세요.', 422)
            source = self.factory.directory(owner, base_id)
            body_file = source/'native-parts'/native['version']/'body.glb'
            body_hash = next((a['sha256'] for a in native['artifacts'] if a['name'] == 'body.glb'), None)
            if not body_hash or digest(body_file) != body_hash:
                raise PipelineError('body_changed', '기본 몸 파일을 확인할 수 없습니다.', 409)
            default_profile = FittingManagement(self.factory, owner).body_default()
            default_body = default_profile.get('body') or {}
            facts = body_facts(body_file, body_hash)
            body_geometry_sha256 = facts['identity']
            historical_body = (photo_input is not None and AvatarNativeParts(self.factory).get(owner, base_id).get('version') != native['version'])
            if historical_body and (
                    default_body.get('job_id') != base_id
                    or default_body.get('body_sha256') != body_hash
                    or default_body.get('geometry_sha256') != body_geometry_sha256):
                raise PipelineError('base_changed', '저장된 공통 몸과 같은 형상의 몸 버전을 다시 선택하세요.', 409)
            original = read_json(source/'pipeline.json')
            native_input = read_json(source/'native-parts'/native['version']/'input.json')
            if not original.get('production_spec') or (photo_input is None and any(p['model']['status'] != 'ready' for p in original['parts'])):
                raise PipelineError('base_incomplete', '정면·측면과 파츠가 저장된 기본 몸을 선택하세요.', 422)
            character_id, character_name = base['character_id'], base['character_name']
            image_source, source_hash = source/'source.png', base['source_sha256']
            if base.get('input_kind') == 'glb':
                source_hash = digest(image_source)
            blueprint = None
            if photo_input is not None:
                image_service = AvatarImagePipeline(self.factory)
                character = self.factory.pipeline.detail(photo_input['character_id'], owner)
                image_source = self.factory.pipeline.artifact(character['id'], owner, 'reference')
                source_hash = digest(image_source)
                if source_hash != photo_input['source_sha256']:
                    raise PipelineError('source_changed', '원본 이미지가 바뀌었습니다. 다시 불러오세요.', 409)
                blueprint = image_service.blueprints.read(owner, character['id'])
                if blueprint['revision'] != photo_input['blueprint_revision']:
                    raise PipelineError('revision_conflict', '설계가 바뀌었습니다. 다시 불러오세요.', 409)
                character_id, character_name = character['id'], character['name']
                prompts = photo_input.get('design_prompts') or {}
                if (not isinstance(prompts, dict) or not set(prompts) <= set(DEFAULT_DESIGN_PROMPTS)
                        or any(not isinstance(value, str) or len(value) > 2000 for value in prompts.values())):
                    raise PipelineError('invalid_design_prompts', '파츠 디자인 프롬프트를 다시 확인하세요.', 422)
            # Acceptance is the final write. Interrupted staging can be repeated using
            # the same key; no provider call occurs until a complete job is accepted.
            (target/'output').mkdir(parents=True, exist_ok=True)
            staged.append((copy_file, image_source, target/'source.png'))
            state = deepcopy(original)
            # A prepared body has no image provider. New part requests still
            # freeze the configured image provider at their own acceptance.
            state.update(image_provider='openai', image_model=capabilities()['image_model'],
                         image_base=os.getenv('OPENAI_API_BASE', DEFAULT_BASE).rstrip('/'),
                         meshy_base=base_url('meshy'))
            if redraw and frozen_context and frozen_context.get('image_settings'):
                state.update(deepcopy(frozen_context['image_settings']))
            view_mode = (photo_input or payload).get('view_mode')
            generated_views = (tuple(redraw['views']) if redraw else
                               ('front', 'side', 'back') if view_mode == 'front_side_back' else ('front', 'side'))
            # Repair/reuse pointers are scoped to their owning job and native
            # version. A child job must establish fresh snapshots below instead
            # of looking for the parent's version under its own directory.
            for inherited_intent in ('local_refit', 'native_part_reuse', 'expression_reuse', 'native_assembly_version', 'uploaded_glb'):
                state.pop(inherited_intent, None)
            if photo_input is not None:
                # Only the selected body is inherited; the uploaded photo owns every new part.
                state['parts'] = [{'slot': 'body', 'views': {view: {'status': 'pending'} for view in generated_views},
                                   'image': {'status': 'pending'}, 'model': {'status': 'ready', 'origin': 'frozen_body', 'task_id': None}}]
                state['blueprint'] = blueprint
                state['design_prompts'] = {**{slot: prompt_snapshot['parts'][slot] for slot in DEFAULT_DESIGN_PROMPTS}, **prompts}
                state['reference_preparation'] = initial_reference_state(frozen_body=True, prompts=prompt_snapshot['reference']) if photo_input.get('prepare_reference') else None
                from src.services.avatar_expression_pipeline import default_contract
                state['default_expressions'] = default_contract(prompt_snapshot['expression']) if photo_input.get('default_expressions') else None
            else:
                if payload.get('single_part'):
                    # The frozen body GLB already carries the saved face/body state.
                    # Do not enqueue the five paid default-expression requests again.
                    state['default_expressions'] = None
                    from src.services.avatar_expression_reuse import snapshot_saved_expressions
                    state['expression_reuse'] = snapshot_saved_expressions(
                        self.factory, owner, base_id, native['version'], target)
                elif state.get('default_expressions'):
                    from src.services.avatar_expression_pipeline import default_contract
                    state['default_expressions'] = default_contract(prompt_snapshot['expression'])
                reference = state.get('reference_preparation')
                if (view_mode == 'front_side_back' or redraw) and uses_legacy_side_pose(reference):
                    # A new T-pose part must not inherit an old I-pose appearance reference.
                    reference = None
                    state['reference_preparation'] = None
                if reference and reference.get('status') == 'succeeded':
                    for image in [reference, *reference.get('views', {}).values()]:
                        for field, hash_field in (('file', 'sha256'), ('raw_file', 'raw_sha256')):
                            name = image.get(field)
                            if not name:
                                continue
                            if Path(name).name != name or digest(source/'output'/name) != image.get(hash_field):
                                raise PipelineError('reference_changed', '저장된 공통 규격 원본이 변경되었습니다.', 409)
                            staged.append((copy_file, source/'output'/name, target/'output'/name))
                else:
                    state['reference_preparation'] = None
            hair_length = (requested_hair_length(payload) if 'hair' in slots
                           else original.get('hair_length', 'source'))
            inherited_spec = native_input.get('production_spec') or original['production_spec']
            inherited_profiles = inherited_spec.get('fit_profiles', {})
            native_reports = {part['slot']: part for part in native.get('parts', [])}
            body_profile_identity = inherited_spec.get('body_profile_identity')
            if body_profile_identity and body_profile_identity.get('body_sha256') != body_hash:
                body_profile_identity = None
            if body_profile_identity is None:
                if (default_body.get('job_id') == base_id
                        and default_body.get('body_sha256') == body_hash
                        and default_body.get('geometry_sha256') == body_geometry_sha256):
                    body_profile_identity = {
                        'revision': default_profile.get('revision'),
                        'profile_id': default_body.get('profile_id'),
                        'geometry_sha256': default_body.get('geometry_sha256'),
                        'body_sha256': body_hash,
                        'job_id': base_id,
                        'version': native['version'],
                    }
            native_body_profile = native.get('body_profile')
            default_measurements = (default_body.get('measurements')
                                    if default_body.get('body_sha256') == body_hash else None)
            body_profile = native_body_profile or default_measurements or inherited_spec.get('body_profile')
            descriptions = (state.get('design_prompts', {}) if photo_input is not None
                            else payload.get('descriptions', {}))
            fit_profiles = {}
            for garment_slot in ('top', 'bottom'):
                if garment_slot in slots:
                    garment_kind = (requested_bottom_kind(payload) if garment_slot == 'bottom' else 'source')
                    fit_profile = normalize_fit_profile(
                        submitted_fit_profiles.get(garment_slot), slot=garment_slot,
                        description=descriptions.get(garment_slot, ''), kind=garment_kind)
                    reject_generation_fit_profile(fit_profile, slot=garment_slot)
                else:
                    inherited_part = next((part for part in state['parts'] if part['slot'] == garment_slot), {})
                    report = native_reports.get(garment_slot, {})
                    inherited = (report.get('fit_profile')
                                 or report.get('measurement', {}).get('fit_profile')
                                 or inherited_part.get('fit_profile')
                                 or inherited_profiles.get(garment_slot))
                    if inherited is None:
                        continue
                    fit_profile = normalize_fit_profile(
                        inherited, slot=garment_slot,
                        description=inherited_part.get('description', ''),
                        kind=inherited_part.get('garment_kind', 'source'))
                fit_profiles[garment_slot] = fit_profile
            state.update(base_body={'job_id': base_id, 'version': native['version'], 'sha256': body_hash},
                         hair_length=hair_length,
                         production_spec=production_spec(
                             hair_length, generated_views, fit_profiles=fit_profiles,
                             body_profile=body_profile,
                             body_profile_identity=body_profile_identity),
                         motion_actions={}, rig_with_meshy=True)
            state['hair_length_selection'] = {'requested': payload['hair_length'], 'resolved': hair_length}
            state['production_spec']['frozen_body'] = True
            if inherited_spec.get('base_body', {}).get('source_preserved'):
                state['production_spec']['base_body']['source_preserved'] = True
                if inherited_spec['base_body'].get('preserve_face_texture'):
                    state['production_spec']['base_body']['preserve_face_texture'] = True
                if photo_input is None:
                    state['production_spec']['design_from_body_template'] = True
            state['production_spec']['fitting']['bounds'].update(deepcopy(native['fitting_targets']))
            equipment_spec(state['production_spec'])
            state['production_spec'] = seal_production_spec(state['production_spec'])
            historical_hair = ('head', 'hairBack', 'hairFront')
            if (not payload.get('single_part') and 'hair' in slots
                    and any(p['slot'] == 'head' for p in state['parts']) and 'hat' not in slots):
                raise PipelineError('headwear_required', '기존 일체형 머리를 교체할 때는 헤어와 머리 장식을 함께 선택하세요.', 422)
            state['parts'] = [p for p in state['parts'] if p['slot'] in ('body', *VARIANT_SLOTS, *historical_hair)
                             and not ('hair' in slots and p['slot'] in historical_hair)]
            from src.services.avatar_part_methods import choose_key_color
            art = None
            if uploaded_views and uploaded_views.get('front'):
                from src.services.avatar_blueprints import AvatarBlueprints
                art = AvatarBlueprints(self.factory.data).asset(owner, uploaded_views['front']).read_bytes()
            elif photo_input is not None:
                art = image_source.read_bytes()
            key_color = choose_key_color(art, ' '.join(str(v) for v in (descriptions or {}).values()))
            state['model_provider'] = model_provider
            for slot in slots:
                if not any(p['slot'] == slot for p in state['parts']):
                    state['parts'].append({'slot': slot})
            reused = []
            for part in state['parts']:
                slot = part['slot']
                if slot in slots:
                    if uploaded_model:
                        part.update(description=payload.get('part_name') or prompt_snapshot['parts'][slot],
                                    views={}, image={'status': 'not_required'},
                                    model={'status': 'ready', 'task_id': None, 'origin': 'uploaded_glb'},
                                    preserve_generated_detail=True,
                                    provenance={'origin': 'uploaded_glb', 'asset_id': uploaded_model['asset_id']})
                    else:
                        part['meshy_options'] = meshy_options[slot]
                        part.update(description=payload.get('descriptions', {}).get(slot) or prompt_snapshot['parts'][slot],
                                    views={v: {'status': 'pending'} for v in generated_views},
                                    image={'status': 'pending'}, model={'status': 'pending'},
                                    provenance={'origin': 'generated_for_frozen_body', 'source_job_id': base_id})
                    method = part_methods[slot]
                    part['part_method'] = method
                    part.pop('key_color', None)
                    if needs_key_render(method):
                        part['key_color'] = key_color
                    if method == 'body_shell':
                        # Made from the frozen body at assembly; no provider model exists.
                        part.pop('meshy_options', None)
                        part['model'] = {'status': 'ready', 'task_id': None, 'origin': 'body_shell'}
                    if photo_input is not None:
                        part['design_prompt'] = state['design_prompts'][slot]
                    else:
                        part['design_prompt'] = part['description']
                        state.setdefault('design_prompts', {})[slot] = part['design_prompt']
                    if slot == 'bottom':
                        part['garment_kind'] = fit_profiles['bottom']['kind']
                        if part['garment_kind'] == 'skirt':
                            part['description'] += ' Lower garment type: SKIRT, one continuous open hem, no trouser legs or crotch split.'
                        elif part['garment_kind'] == 'pants':
                            part['description'] += ' Lower garment type: TROUSERS, separate left/right leg openings and crotch.'
                    if slot in fit_profiles:
                        part['fit_profile'] = deepcopy(fit_profiles[slot])
                    part.pop('target_bounds_m', None)
                    part.pop('hair_redraw', None)
                    part.pop('source_views', None)
                    part.pop('model_attempts', None)  # Resubmission limits belong to this new request.
                    if uploaded_model:
                        model_path = target/'parts'/slot/'generated.glb'
                        model_path.parent.mkdir(parents=True, exist_ok=True)
                        staged.append((copy_file, Path(uploaded_model['path']), model_path))
                        _write_json(model_path.parent/'generation-artifacts.json', {'generated': {
                            'path': str(model_path), 'sha256': uploaded_model['sha256'],
                            'origin': 'uploaded_glb', 'asset_id': uploaded_model['asset_id']}})
                    elif uploaded_views:
                        from src.services.avatar_blueprints import AvatarBlueprints
                        assets = AvatarBlueprints(self.factory.data)
                        for view, asset_id in uploaded_views.items():
                            asset = assets.asset(owner, asset_id)
                            if digest(asset) != asset_id:
                                raise PipelineError('source_changed', '파츠 원본이 변경되었습니다.', 409)
                            name = f'{slot}-source-{view}.png' if redraw else f'{slot}-{view}.png'
                            staged.append((copy_file, asset, target/'output'/name))
                            collection = part.setdefault('source_views', {}) if redraw else part['views']
                            collection[view] = {'status': 'succeeded', 'file': name, 'sha256': asset_id,
                                                'asset': asset_id, 'origin': 'uploaded_part'}
                        if redraw:
                            part['hair_redraw'] = deepcopy(redraw)
                            part['provenance']['origin'] = 'redrawn_uploaded_hair'
                        else:
                            part['image'] = deepcopy(part['views']['front'])
                            part['provenance']['origin'] = 'uploaded_part_views'
                    continue
                reused.append(slot)
                part['provenance'] = {'origin': 'reused', 'source_job_id': base_id}
                if slot in fit_profiles:
                    part['fit_profile'] = deepcopy(fit_profiles[slot])
                if photo_input is not None and slot == 'body':
                    model_path = target/'parts'/'body'/'generated.glb'
                    model_path.parent.mkdir(parents=True, exist_ok=True)
                    staged.append((copy_file, body_file, model_path))
                    _write_json(model_path.parent/'generation-artifacts.json', {'generated': {
                        'path': str(model_path), 'sha256': body_hash,
                        'reused_from': {'job_id': base_id, 'version': native['version'], 'slot': 'body'}}})
                    continue
                for view in (part.get('views') or {}).values():
                    name = view['file']
                    if Path(name).name != name or digest(source/'output'/name) != view['sha256']:
                        raise PipelineError('image_changed', '기본 파츠 이미지가 변경되었습니다.', 409)
                    staged.append((copy_file, source/'output'/name, target/'output'/name))
                    if view.get('raw_file'):
                        raw_name = view['raw_file']
                        if Path(raw_name).name != raw_name or digest(source/'output'/raw_name) != view.get('raw_sha256'):
                            raise PipelineError('image_changed', '저장된 고화질 원본 이미지가 변경되었습니다.', 409)
                        staged.append((copy_file, source/'output'/raw_name, target/'output'/raw_name))
                    # Reused views are not charged against this request's limit.
                    for field in ('attempted_at', 'previous_attempts'):
                        view.pop(field, None)
                for view in (part.get('source_views') or {}).values():
                    name = view['file']
                    if Path(name).name != name or digest(source/'output'/name) != view.get('sha256'):
                        raise PipelineError('image_changed', '저장된 헤어 입력 원본이 변경되었습니다.', 409)
                    staged.append((copy_file, source/'output'/name, target/'output'/name))
                # An uploaded 3D part has no generated views.
                part['image'] = deepcopy(part['views']['front']) if part.get('views') else deepcopy(part.get('image') or {'status': 'not_required'})
                if part.get('part_method') == 'body_shell':
                    continue
                receipt = read_json(source/'parts'/slot/'generation-artifacts.json')['generated']
                if digest(source/'parts'/slot/'generated.glb') != receipt['sha256']:
                    raise PipelineError('model_changed', '저장된 파츠 모델이 변경되었습니다.', 409)
                staged.append((copy_tree, source/'parts'/slot, target/'parts'/slot))
            state['reuse'] = {'source_job_id': base_id, 'slots': reused}
            if redraw:
                body_part = next(part for part in state['parts'] if part['slot'] == 'body')
                for view in generated_views:
                    body_part['views'].setdefault(view, {'status': 'pending'})
            if payload.get('single_part'):
                native_record = read_json(source/'native-parts'/native['version']/'record.json')
                native_files = native_record.get('files', {})
                native_reports = {part['slot']: part for part in native_record.get('result', {}).get('parts', [])}
                frozen_parts = {}
                for part in state['parts']:
                    slot = part['slot']
                    if slot == 'body' or slot in slots:
                        continue
                    name = f'{slot}.glb'
                    fitted = source/'native-parts'/native['version']/name
                    expected = native_files.get(name)
                    if not expected or not fitted.is_file() or digest(fitted) != expected:
                        raise PipelineError('fitted_part_changed', f'저장된 {slot} 피팅 파츠를 확인할 수 없습니다.', 409)
                    target_name = f'{slot}.glb'
                    staged.append((copy_file, fitted, target/'prefit-parts'/target_name))
                    frozen_parts[slot] = {'file': target_name, 'sha256': expected,
                                          'report': native_reports.get(slot, {})}
                state['native_part_reuse'] = {
                    'source_job_id': base_id, 'source_version': native['version'], 'parts': frozen_parts}
            version = body_hash[:24]
            rigdir = target/'meshy/versions'/version
            staged.append((copy_file, body_file, rigdir/'model.glb'))
        for copy, origin, destination in staged:
            copy(origin, destination)
        with _LOCK:
            prior = read_json(target/'job.json')
            if prior:
                # Another request with this key was accepted while the files were copied.
                if prior['fingerprint'] != fingerprint:
                    raise PipelineError('idempotency_conflict', '같은 요청의 입력이 변경되었습니다.', 409)
                return self.factory.get(owner, job_id), False
            # A minimal sealed rig delivery contains the actual chosen body and its
            # clips. It never copies another job's active provider worker or intent.
            rigdir.mkdir(parents=True, exist_ok=True)
            receipt = {'version': version, 'files': {'model.glb': body_hash},
                       'bone_count': native['bone_count'],
                       'clips': [{'slot': name, 'source': 'frozen_body', 'action_id': None} for name in facts['clips']],
                       'origin': 'frozen_body'}
            _write_json(rigdir/'receipt.json', receipt)
            _write_json(target/'meshy/delivery.json', receipt)
            _write_json(target/'meshy/worker.json', {'status': 'complete', 'origin': 'frozen_body'})
            _write_json(target/'pipeline.json', state)
            _write_json(target/'job.json', {'id': job_id, 'fingerprint': fingerprint,
                'executor': self.factory.instance, 'executor_process': identity(),
                'character_id': character_id, 'character_name': character_name,
                'source_sha256': source_hash, 'input_kind': 'image',
                **({'input': photo_input} if photo_input is not None else {}),
                'production_mode': 'character_parts', 'auto_assemble': True, 'profile': base['profile'],
                'status': 'pipeline_queued', 'created_at': now(), 'updated_at': now(), 'error': None,
                'base_job_id': base_id, 'base_version': native['version'], 'requested_slots': slots,
                'meshy_options': ({} if uploaded_model else
                                  {slot: frozen['options'] for slot, frozen in meshy_options.items()}),
                **({'resume_stage': 'images' if redraw else 'models', 'part_name': payload.get('part_name', '')}
                   if uploaded_views or uploaded_model else {}),
                # A generated part keeps the name it was asked for, as the wardrobe lists it.
                **({'part_name': payload['part_name']} if payload.get('part_name') else {}),
                'limits': {'image_tasks': (0 if (uploaded_views and not redraw) or uploaded_model else len(generated_views)*len(slots)) + (2 if photo_input is not None and state.get('reference_preparation') else 0),
                           'reference_tasks': 2 if photo_input is not None and state.get('reference_preparation') else 0,
                           'expression_tasks': (0 if payload.get('single_part') else 5 if state.get('default_expressions') else 0),
                           'meshy_tasks': 0 if uploaded_model else sum(needs_provider(part_methods[s]) for s in slots),
                           'meshy_rig_tasks': 0, 'meshy_animation_tasks': 0},
                'review': {'decision': 'pending'}, 'files': {}})
            AvatarImagePipeline(self.factory).publish(owner, job_id, state)
            return self.factory.get(owner, job_id), True


def prepare_body(service, owner, job_id, state):
    """Render exact frozen-body references before any new image request."""
    if not state.get('base_body') or state['base_body'].get('prepared'):
        return
    directory = service.factory.directory(owner, job_id)
    body_hash = state['base_body']['sha256']
    body = directory/'meshy/versions'/body_hash[:24]/'model.glb'
    output = directory/'body-reference'
    output.mkdir(exist_ok=True)
    runner = read_json(output/'runner.json')
    if runner and process_state(runner.get('process')) != 'exited':
        raise PipelineError('body_render_running', '기존 기본 몸 렌더가 실행 중입니다.', 409)
    worker = Path(__file__).with_name('avatar_body_reference_blender.py')
    legacy_side_i = uses_legacy_side_pose(state.get('reference_preparation'))
    _write_json(output/'input.json', {'source': str(body), 'sha256': body_hash,
        'worker_sha256': digest(worker), 'output': str(output), 'spec': state['production_spec'],
        'legacy_side_i': legacy_side_i})
    required = {'spec.json', *(f'body-{view}.png' for view in state['production_spec']['generated_views'])}
    if legacy_side_i:
        required.add('body-side-i.png')
    # Batch children share one frozen body and spec: reuse its sealed renders.
    cache_key = hashlib.sha256(json.dumps({'body': body_hash, 'spec': state['production_spec'],
        'worker': digest(worker), 'legacy_side_i': legacy_side_i}, sort_keys=True).encode()).hexdigest()[:24]
    cache = service.factory.root/str(int(owner))/'body-reference-cache'/cache_key
    shared = read_json(cache/'complete.json')
    if (required <= shared.get('files', {}).keys()
            and all((cache/name).is_file() and digest(cache/name) == shared['files'][name] for name in required)
            and not read_json(output/'complete.json').get('input_sha256') == digest(output/'input.json')):
        for name in required:
            copy_file(cache/name, output/name)
        _write_json(output/'complete.json', {'input_sha256': digest(output/'input.json'),
            'files': {name: shared['files'][name] for name in required}, 'reused_from': cache_key})
    try:
        with local_workspace(output, inputs=[body]):
            seal = read_json(output/'complete.json')
            cached = (seal.get('input_sha256') == digest(output/'input.json')
                      and required <= seal.get('files', {}).keys()
                      and all((output/name).is_file() and digest(output/name) == seal['files'][name] for name in required))
            if not cached:
                render_body_reference(output, worker)
            seal = read_json(output/'complete.json')
            if (seal.get('input_sha256') != digest(output/'input.json') or not required <= seal.get('files', {}).keys()
                    or any(not (output/name).is_file() or digest(output/name) != seal['files'][name] for name in required)):
                raise PipelineError('body_render_failed', '기본 몸 참조 렌더 저장 확인 실패', 409)
    except WorkspaceUploadError:
        # The render stays on disk and is stored when the next one ends. The job pauses with this message, not with
        # an internal error, and a resume renders again.
        raise PipelineError('body_render_failed', '기본 몸 참조 렌더 저장 실패', 409) from None
    if not shared.get('files'):
        for name in required:
            copy_file(output/name, cache/name)
        _write_json(cache/'complete.json', {'files': {name: seal['files'][name] for name in required}})
    state['production_spec'] = read_json(output/'spec.json')
    state['body_height_m'] = state['production_spec']['body_height_m']
    part = next(p for p in state['parts'] if p['slot'] == 'body')
    for view in state['production_spec']['generated_views']:
        name = f'body-{view}.png'
        copy_file(output/name, directory/'output'/name)
        part['views'][view] = {'status': 'succeeded', 'file': name,
                              'sha256': digest(directory/'output'/name), 'origin': 'frozen_body_render'}
    part['image'] = deepcopy(part['views']['front'])
    if legacy_side_i:
        copy_file(output/'body-side-i.png', directory/'output'/'body-side-i.png')
    state['base_body']['prepared'] = True
    service.publish(owner, job_id, state)


def render_body_reference(output, worker):
        # Called by prepare_body inside its local_workspace and never while the queue is held:
        # the same workspace-then-queue order as native assembly. The render timeout starts
        # once a BLENDER_CONCURRENCY slot is granted.
        with _QUEUE, blender_process(
                [blender_executable(), '--background', '--disable-autoexec', '--python-exit-code', '1', '--threads', '2', '--python',
                 str(worker), '--', str(output/'input.json')],
                output/'blender.log', output/'runner.json', write_json=_write_json) as process:
            try:
                code = process.wait(timeout=240)
            except subprocess.TimeoutExpired:
                stop_process(process)
                raise PipelineError('body_render_timeout', '기본 몸 참조 렌더 시간 초과', 409) from None
            if code:
                raise PipelineError('body_render_failed', '기본 몸 참조 렌더 실패', 409)
