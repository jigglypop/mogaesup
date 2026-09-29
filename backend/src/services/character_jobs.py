"""Persisted Meshy jobs shared by CLI and HTTP. Callers hold the run lock."""

import base64
from datetime import datetime, timezone
import io
import json
from src.services.object_storage import StoredPath as Path, copy_file
import re

import httpx
from PIL import Image

from src.services.asset_editor import _write_json
from src.services.runtime_activity import paid_request
from src.services.wardrobe import _digest, download_glb

# Meshy did not accept these requests, so a new submission cannot duplicate a task.
NOT_ACCEPTED = {400, 401, 402, 403, 404, 422, 429, 503}
RETRYABLE = ('FAILED', 'CANCELED', 'submission_rejected', 'submission_not_sent', 'submission_uncertain')
ATTEMPT_FILES = ('character.json', 'generation-result.json', 'generation-submission-response.json',
                 'rigging-result.json', 'rigging-submission-response.json', 'rig-input.glb')


def state(directory: Path) -> dict:
    return json.loads((directory / "character.json").read_text(encoding="utf-8"))


def save_submission_response(directory, name, response):
    # Keep provider evidence in private asset storage, never in a public error.
    _write_json(directory / f'{name}-submission-response.json', {
        'http_status': response.status_code,
        'request_id': response.headers.get('x-request-id'),
        'body': response.text,
    })


def archive_attempt(directory: Path, reason: str) -> int:
    """Move a finished or unaccepted attempt aside, keeping its receipts, before a new submission."""
    value = state(directory)
    if value.get("status") not in RETRYABLE:
        raise ValueError("Only failed or unaccepted Meshy attempts can be replaced")
    attempts = directory / "attempts"
    index = len(list(attempts.glob("*/archive.json"))) + 1
    target = attempts / str(index)
    for name in ATTEMPT_FILES:
        source = directory / name
        if source.is_file():
            copy_file(source, target / name)
    _write_json(target / "archive.json", {
        "reason": reason, "status": value.get("status"), "http_status": value.get("http_status"),
        "task_id": value.get("task_id"), "stage": value.get("stage"),
        "archived_at": datetime.now(timezone.utc).isoformat()})
    for name in ATTEMPT_FILES:
        source = directory / name
        if source.is_file():
            source.unlink()
    return index


def _submit(directory: Path, value: dict, endpoint: str, payload: dict, client: httpx.Client) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    _write_json(directory / "character.json", value)
    try:
        with paid_request():
            response = client.post(endpoint, json=payload)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
        # The connection never opened, so Meshy cannot have received this request.
        value.update(status="submission_not_sent")
        _write_json(directory / "character.json", value)
        raise
    if response.status_code in NOT_ACCEPTED:
        value.update(status="submission_rejected", http_status=response.status_code)
        _write_json(directory / "character.json", value)
    save_submission_response(directory, value['stage'], response)
    response.raise_for_status()
    if value.get('provider') == 'tripo':
        from src.services.model_providers import tripo_refusal, tripo_task_id
        body = response.json()
        refusal = tripo_refusal(body)
        if refusal is not None:
            # A non-zero code in a 200 answer created no task: a definite refusal, not an
            # unknown outcome. The raw body stays in the private submission receipt.
            from src.services.character_pipeline import PipelineError
            value.update(status="submission_rejected", http_status=response.status_code,
                         provider_code=refusal['code'])
            _write_json(directory / "character.json", value)
            raise PipelineError('provider_rejected', refusal['message'], 422)
        task_id = tripo_task_id(body)
    else:
        task_id = response.json().get("result")
    if not isinstance(task_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", task_id):
        raise ValueError("Invalid task ID; recover existing submission before retrying")
    value.update(task_id=task_id, status="PENDING")
    _write_json(directory / "character.json", value)
    return value


def generate(directory: Path, image: Path, height: float, client: httpx.Client, profile: str = "meshy-7", *, isolated_part: bool = False, body_type: str = "humanoid", texture_prompt: str | None = None) -> dict:
    if (directory / "character.json").exists():
        raise ValueError("Existing run: refresh or recover; never resubmit an uncertain task")
    if not 0.1 <= height <= 100:
        raise ValueError("Invalid height")
    if body_type not in {"humanoid", "quadruped"}:
        raise ValueError("Unknown body type")
    image = image.resolve()
    if image.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
        raise ValueError("Image must be PNG or JPEG")
    with Image.open(io.BytesIO(image.read_bytes())) as reference:
        reference.verify()
    if profile not in {"meshy-7", "smart-topology"}:
        raise ValueError("Unknown generation profile")
    value = {"image": str(image), "image_sha256": _digest(image), "height_meters": height, "profile": profile,
             "stage": "generation", "status": "submission_uncertain", "body_type": body_type}
    mime = "image/png" if image.suffix.lower() == ".png" else "image/jpeg"
    payload = {"image_url": f"data:{mime};base64," + base64.b64encode(image.read_bytes()).decode(),
               "ai_model": "meshy-7", "model_type": "standard", "should_texture": True, "enable_pbr": True,
               "should_remesh": True, "target_polycount": 8000, "pose_mode": "t-pose",
               "image_enhancement": False, "target_formats": ["glb"]}
    if profile == "smart-topology":
        payload.update(model_type="smart-topology", ai_model="meshy-t2", target_polycount=15000)
        payload.pop("should_remesh")
        payload.pop("image_enhancement")  # Documented only for Meshy 6/7; do not send unsupported controls.
    if isolated_part:
        payload.pop('pose_mode', None)  # A hat or shoe is not a humanoid to pose/auto-rig.
        payload['target_polycount'] = 2000
    if body_type == "quadruped":
        payload.pop("pose_mode", None)
    if texture_prompt is not None:
        if profile != 'meshy-7' or not isinstance(texture_prompt, str) or not 1 <= len(texture_prompt.strip()) <= 600:
            raise ValueError('Meshy 7 texture prompt must contain 1 to 600 characters')
        payload['texture_prompt'] = texture_prompt.strip()
    value["generation_settings"] = {k: v for k, v in payload.items() if k != "image_url"}
    return _submit(directory, value, "/openapi/v1/image-to-3d", payload, client)


def rig(directory: Path, client: httpx.Client) -> dict:
    value = state(directory)
    if value.get("body_type", "humanoid") != "humanoid":
        raise ValueError("Quadruped rigging requires the Meshy web app; the public Rigging API supports humanoids only")
    if value["stage"] != "generation" or value["status"] != "SUCCEEDED":
        raise ValueError("A successful generation is required before rigging")
    task_id = value.pop("task_id")
    value.update(generation_task_id=task_id, stage="rigging", status="submission_uncertain", progress=0)
    return _submit(directory, value, "/openapi/v1/rigging",
                   {"input_task_id": task_id, "height_meters": value["height_meters"]}, client)


def generate_multiview_part(directory: Path, images: list[Path], client: httpx.Client, *, isolated_part=True,
                            height=1.2, expected_views: list[str] | None = None,
                            texture_prompt: str | None = None, preserve_geometry: bool = False,
                            quality_profile: str | None = None, generation_options: dict | None = None,
                            provider: str = 'meshy', image_urls: list[str] | None = None,
                            face_limit: int | None = None) -> dict:
    """One submission using the caller's frozen quality and view contract.

    image_urls: short-lived URLs of the same stored images, sent instead of data
    URIs. Tripo accepts only URLs; Meshy accepts either.
    """
    if (directory/'character.json').exists():
        raise ValueError('Existing run: recover or refresh, never resubmit')
    if not 1 <= len(images) <= 4:
        raise ValueError('One to four views of the same object are required')
    if expected_views is not None and (
            expected_views not in (['front', 'side'], ['front', 'side', 'back'], ['front', 'side', 'back', 'opposite'])
            or len(images) != len(expected_views)):
        raise ValueError('Images must match the accepted ordered view contract')
    urls, sources = [], []
    for index, image in enumerate(images):
        with Image.open(io.BytesIO(image.read_bytes())) as reference:
            if reference.format != 'PNG':
                raise ValueError('Prepared PNG required')
            reference.verify()
        sources.append({'image_sha256': _digest(image),
                        **({'view': expected_views[index], 'name': image.name} if expected_views is not None else {})})
        urls.append('data:image/png;base64,'+base64.b64encode(image.read_bytes()).decode('ascii'))
    if image_urls is not None:
        if len(image_urls) != len(images):
            raise ValueError('One URL per view is required')
        urls = list(image_urls)
    if provider == 'tripo':
        from src.services.model_providers import tripo_payload
        if expected_views is None or image_urls is None:
            raise ValueError('Tripo needs ordered views and stored-image URLs')
        payload = tripo_payload(dict(zip(expected_views, urls)), face_limit=face_limit)
        value = {'stage': 'generation', 'status': 'submission_uncertain', 'profile': payload['model_version'],
                 'provider': 'tripo', 'generation_endpoint': '/task', 'sources': sources,
                 'isolated_part': isolated_part, 'height_meters': height, 'body_type': 'humanoid',
                 'generation_settings': {k: v for k, v in payload.items() if k != 'files'},
                 'preserve_download_detail': True}
        return _submit(directory, value, '/task', payload, client)
    payload = {'image_urls': urls, 'ai_model': 'meshy-7', 'should_texture': True, 'enable_pbr': True,
               'should_remesh': True, 'target_polycount': 2000, 'image_enhancement': False,
               'remove_lighting': True, 'target_formats': ['glb']}
    if not isolated_part:
        payload.update(target_polycount=8000, pose_mode='t-pose')
    if preserve_geometry:
        if isolated_part:
            raise ValueError('Geometry preservation requires a whole body')
        payload['should_remesh'] = False
        payload.pop('target_polycount', None)
    if quality_profile is not None:
        if quality_profile != 'high-v1' or isolated_part or not preserve_geometry:
            raise ValueError('High quality requires a preserved whole body')
        payload.update(ai_model='meshy-7.1', geometry_resolution='2k', texture_resolution='4k')
    if texture_prompt is not None:
        if not isinstance(texture_prompt, str) or not 1 <= len(texture_prompt.strip()) <= 800:
            raise ValueError('Meshy texture prompt must contain 1 to 800 characters')
        payload['texture_prompt'] = texture_prompt.strip()
    if generation_options is not None:
        payload = {'image_urls': urls, **generation_options}
    endpoint = '/openapi/v1/multi-image-to-3d'
    value = {'stage': 'generation', 'status': 'submission_uncertain', 'profile': payload['ai_model'],
             'generation_endpoint': endpoint, 'sources': sources, 'isolated_part': isolated_part,
             'height_meters': height, 'body_type': 'humanoid',
             'generation_settings': {k: v for k, v in payload.items() if k not in ('image_urls', 'texture_image_url', 'texture_image_urls')},
             'preserve_download_detail': generation_options is not None}
    return _submit(directory, value, endpoint, payload, client)


def generate_tripo_image(directory: Path, image: Path, image_url: str, client: httpx.Client, *,
                         face_limit: int | None = None) -> dict:
    """One Tripo image_to_model submission of a stored PNG, sent by its short-lived URL."""
    from src.services.model_providers import tripo_image_payload
    if (directory/'character.json').exists():
        raise ValueError('Existing run: recover or refresh, never resubmit')
    with Image.open(io.BytesIO(image.read_bytes())) as reference:
        if reference.format != 'PNG':
            raise ValueError('Prepared PNG required')
        reference.verify()
    payload = tripo_image_payload(image_url, face_limit=face_limit)
    value = {'stage': 'generation', 'status': 'submission_uncertain', 'profile': payload['model_version'],
             'provider': 'tripo', 'generation_endpoint': '/task', 'sources': [{'image_sha256': _digest(image)}],
             'isolated_part': True, 'generation_settings': {k: v for k, v in payload.items() if k != 'file'},
             'preserve_download_detail': True}
    return _submit(directory, value, '/task', payload, client)


def rig_model(directory: Path, model: Path, height: float, client: httpx.Client, *, body_type: str = "humanoid") -> dict:
    """Rig an existing textured assembly without regenerating its source parts.

    Callers hold run_lock. A lost POST leaves its durable intent for task-ID
    recovery, exactly like image generation. The input GLB is never overwritten.
    """
    from src.services.asset_delivery import inspect_glb
    from src.services.glb import parse_glb
    import hashlib

    if body_type != "humanoid":
        raise ValueError("Quadruped rigging requires the Meshy web app; the public Rigging API supports humanoids only")
    if (directory / "character.json").exists() or (directory / "rig-input.glb").exists():
        raise ValueError("Existing run: refresh or recover; never resubmit an uncertain task")
    if not 0.1 <= height <= 100:
        raise ValueError("Invalid height")
    content = model.read_bytes()
    quality = inspect_glb(content, budget_warnings=True)
    doc, _ = parse_glb(content, strict=True)
    if quality["errors"] or not doc.get("textures") or not doc.get("images"):
        raise ValueError("Meshy rigging requires a valid textured humanoid GLB")
    source_hash = hashlib.sha256(content).hexdigest()
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "rig-input.glb").open("xb") as target:
        target.write(content)
    value = {"stage": "rigging", "status": "submission_uncertain", "body_type": body_type,
             "height_meters": height, "source_sha256": source_hash, "input_kind": "model",
             "generation_settings": {"should_remesh": False},
             "source_model": str(model.resolve()), "provider": "meshy"}
    return _submit(directory, value, "/openapi/v1/rigging", {
        "model_url": "data:model/gltf-binary;base64," + base64.b64encode(content).decode("ascii"),
        "height_meters": height,
    }, client)


def refresh(directory: Path, client: httpx.Client, task_id: str | None = None) -> dict:
    value = state(directory)
    task_id = task_id or value.get("task_id", "")
    if not isinstance(task_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", task_id):
        raise ValueError("Recover the existing Meshy task ID first")
    if value.get('provider') == 'tripo':
        from src.services.model_providers import tripo_state
        response = client.get(f'/task/{task_id}')
        response.raise_for_status()
        task = response.json()
        _write_json(directory / (value["stage"] + "-result.json"), task)
        status, progress = tripo_state(task)
        value.update(task_id=task_id, status=status, progress=progress)
        error = (task.get('data') or {}).get('error_code')
        if status in ('FAILED', 'CANCELED') and isinstance(error, int) and not isinstance(error, bool):
            value['provider_error'] = error
        _write_json(directory / "character.json", value)
        return value
    endpoint = value.get('generation_endpoint', '/openapi/v1/image-to-3d') if value["stage"] == "generation" else "/openapi/v1/rigging"
    if endpoint not in ('/openapi/v1/image-to-3d', '/openapi/v1/multi-image-to-3d', '/openapi/v1/rigging'):
        raise ValueError('Unknown provider endpoint')
    response = client.get(f"{endpoint}/{task_id}")
    response.raise_for_status()
    task = response.json()
    _write_json(directory / (value["stage"] + "-result.json"), task)
    value.update(task_id=task_id, status=task["status"], progress=task.get("progress"))
    _write_json(directory / "character.json", value)
    return value


def download(directory: Path, stage: str, download_model=download_glb) -> dict:
    task = json.loads((directory / (stage + "-result.json")).read_text(encoding="utf-8"))
    tripo = state(directory).get('provider') == 'tripo'
    if (state(directory).get('status') if tripo else task.get("status")) != "SUCCEEDED":
        raise ValueError("Download requires a successful task; refresh status first")
    if tripo:
        from src.services.model_providers import tripo_model_url
        urls = {"generated": tripo_model_url(task)}
    elif stage == "generation":
        urls = {"generated": task.get("model_urls", {}).get("glb")}
    else:
        result = task.get("result") or {}
        urls = {"rigged": result.get("rigged_character_glb_url")}
        for name in ("walking", "running"):
            url = (result.get("basic_animations") or {}).get(name + "_glb_url")
            if url:
                urls[name] = url
    if not next(iter(urls.values())):
        raise ValueError("Task succeeded without a GLB URL")
    artifacts = {}
    saved = state(directory)
    preserve_detail = saved.get('preserve_download_detail') or saved.get('generation_settings', {}).get('should_remesh') is False
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        for name, url in urls.items():
            output = directory / (name + ".glb")
            if preserve_detail and download_model is download_glb:
                quality = download_model(client, url, output, preserve_detail=True)
            else:
                quality = download_model(client, url, output)
            _write_json(directory / (name + "-quality.json"), quality)
            artifacts[name] = {"path": str(output.resolve()), "sha256": _digest(output)}
    _write_json(directory / (stage + "-artifacts.json"), artifacts)
    return artifacts
