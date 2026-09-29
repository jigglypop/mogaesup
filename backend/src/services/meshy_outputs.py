"""Persist requested provider formats and previews alongside the primary GLB."""
import hashlib

import httpx

from src.services.asset_editor import _write_json
from src.services.character_pipeline import PipelineError, read_json
from src.services.object_storage import copy_file
from src.services.wardrobe import download_glb


def publish_extras(directory, job_directory, slot):
    task = read_json(directory/'generation-result.json')
    saved = read_json(directory/'character.json')
    if task.get('status') != 'SUCCEEDED' or not saved.get('preserve_download_detail'):
        return
    settings = saved['generation_settings']
    def outputs(result):
        urls = result.get('model_urls') or {}
        requested = {f'model.{fmt}': urls.get(fmt) for fmt in settings.get('target_formats', []) if fmt != 'glb'}
        if settings.get('save_pre_remeshed_model'):
            requested['pre-remeshed.glb'] = urls.get('pre_remeshed_glb')
        if settings.get('alpha_thumbnail'):
            requested['alpha-thumbnail.png'] = result.get('alpha_thumbnail_url')
        if settings.get('multi_view_thumbnails'):
            requested.update({f'thumbnail-{view}.png': (result.get('thumbnail_urls') or {}).get(view)
                              for view in ('front', 'right', 'back', 'left')})
        return requested
    requested = outputs(task)
    receipts = read_json(directory/'extra-artifacts.json')
    if not requested:
        return
    if any(name not in receipts or not (directory/name).is_file() for name in requested):
        # Recover fresh expiring URLs with GET only, using the original task ID.
        from src.services import character_jobs
        from src.services.avatar_meshy import client
        with client(read_json(job_directory/'pipeline.json')['meshy_base']) as api:
            character_jobs.refresh(directory, api)
        requested = outputs(read_json(directory/'generation-result.json'))
    # This client deliberately has no provider Authorization header.
    with httpx.Client(timeout=120, follow_redirects=True) as downloader:
        for name, url in requested.items():
            target = directory/name
            receipt = receipts.get(name)
            if not receipt or not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != receipt['sha256']:
                if not isinstance(url, str) or not url.startswith('https://'):
                    raise PipelineError('meshy_output_missing', f'{slot}: 요청한 {name} 결과가 없습니다. 저장된 GLB는 유지되며 3D 단계에서 다시 조회할 수 있습니다.', 502)
                if name.endswith('.glb'):
                    download_glb(downloader, url, target, preserve_detail=True)
                else:
                    data = bytearray()
                    with downloader.stream('GET', url) as response:
                        response.raise_for_status()
                        for chunk in response.iter_bytes():
                            data.extend(chunk)
                            if len(data) > 256*1024*1024:
                                raise ValueError('Meshy output exceeds 256MiB')
                    if not data:
                        raise ValueError('Empty Meshy output')
                    target.write_bytes(data)
                receipt = {'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
                receipts[name] = receipt
                _write_json(directory/'extra-artifacts.json', receipts)
            output_name = f'meshy-{slot}-{name}'
            copy_file(target, job_directory/'output'/output_name)
            job = read_json(job_directory/'job.json')
            job.setdefault('files', {})[output_name] = receipt['sha256']
            _write_json(job_directory/'job.json', job)
