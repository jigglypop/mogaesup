"""Isolated real API for browser tests. No provider credentials or production files."""

import os
from pathlib import Path
import tempfile
import shutil

import uvicorn
from fastapi import FastAPI

from api.test_characters import rigged_glb


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="wardrobe-browser-") as directory:
        fixture_root = os.getenv('WORKSPACE_TEST_FACTORY_ROOT')
        if fixture_root:
            shutil.copytree(Path(fixture_root)/'avatar-factory', Path(directory)/'avatar-factory')
        os.environ.update(ASSET_DATA_ROOT=directory, API_KEY="", MESHY_API_KEY="", GEMINI_API_KEY="", OPENAI_API_KEY="",
                          JWT_SECRET_KEY="", BLENDER_PORT="62129", CHARACTER_OWNER_ID="1", CHARACTER_DATABASE_URL="")
        from src.api.characters import router, pipeline_error_handler
        from src.api.avatars import router as avatar_router
        from src.api.avatar_factory import router as factory_router
        from src.api.avatar_blueprints import router as blueprint_router
        from src.services.character_pipeline import CharacterPipeline, PipelineError

        app = FastAPI()
        app.include_router(router, prefix="/api")
        app.include_router(avatar_router, prefix="/api")
        app.include_router(factory_router, prefix="/api")
        app.include_router(blueprint_router, prefix="/api")
        app.add_exception_handler(PipelineError, pipeline_error_handler)

        @app.get('/health')
        def health():
            return {"status": "ok"}

        pipeline = CharacterPipeline(Path(directory), port=62129)
        value = pipeline.create("Browser Fixture", 1.7, 1)
        pipeline.upload(value["id"], 1, rigged_glb(), "model", value["revision"])
        if os.getenv('WORKSPACE_TEST_NATIVE') == '1':
            from native_assembly_fixture import seed_native_assembly
            seed_native_assembly(Path(directory), value['id'], os.getenv('WORKSPACE_TEST_NATIVE_SOURCE'))
        if os.getenv('WORKSPACE_TEST_MESHY') == '1':
            import time
            from services.test_character_preparation import animated_fixture
            from src.services.asset_editor import _write_json
            from src.services.avatar_factory import AvatarFactory, digest
            from src.services.avatar_meshy import AvatarMeshy
            factory = AvatarFactory(Path(directory)); jid = 'c'*24
            job = factory.root/'1'/jid; (job/'output').mkdir(parents=True)
            model = job/'output/generated-body.glb'; model.write_bytes(animated_fixture())
            _write_json(job/'job.json', {'id': jid, 'character_id': value['id'], 'character_name': value['name'],
                'created_at': '2026-09-17T00:00:00+00:00', 'status': 'review_required', 'input_kind': 'image',
                'source_sha256': digest(model), 'profile': {'name': 'Meshy browser fixture', 'rig': 'meshy-native'},
                'parts': [{'slot': 'body', 'image_status': 'succeeded', 'model_status': 'ready'}],
                'files': {'generated-body.glb': digest(model)}})
            run = job/'meshy'; run.mkdir()
            _write_json(run/'character.json', {'stage': 'rigging', 'status': 'SUCCEEDED', 'task_id': 'fixture-rig'})
            receipt = {}
            for name in ('rigged', 'walking', 'running'):
                path = run/(name+'.glb'); path.write_bytes(animated_fixture()); receipt[name] = {'sha256': digest(path)}
            _write_json(run/'rigging-artifacts.json', receipt)
            AvatarMeshy(factory)._publish(run)
            _write_json(factory.root/'1/meshy-library.json', {'fetched_at': time.time(), 'items': [
                {'action_id': n, 'name': label, 'key': label, 'category': category, 'sub_category': category}
                for n, label, category in [(0, 'Idle Fixture', 'DailyActions'), (14, 'Run Fixture', 'WalkAndRun'), (77, 'Walk Fixture', 'WalkAndRun')]]})
        uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("WORKSPACE_TEST_API_PORT", "8012")), log_level="warning")
