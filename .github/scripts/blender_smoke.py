"""Runs inside the studio image's Blender (pipeline.yml, studio-image): the helpers every Blender worker imports load in
Blender's own Python, and a model goes out as GLB and back in through them.

    docker run --rm -v "$PWD/.github/scripts/blender_smoke.py:/smoke.py:ro" <image> \
        blender --background --factory-startup --python-exit-code 1 --python /smoke.py
"""
import os
import sys

# The image keeps the character server in /app/backend; BLENDER_SMOKE_BACKEND points elsewhere (a checkout's backend/).
sys.path.insert(0, os.environ.get('BLENDER_SMOKE_BACKEND', '/app/backend'))

import bpy  # noqa: E402

from src.services.avatar_blender_common import load, sha  # noqa: E402
from src.services.glb import parse_glb  # noqa: E402

PATH = os.path.join(os.environ.get('TMPDIR') or os.environ.get('TEMP') or '/tmp', 'blender-smoke.glb')

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1)
bpy.ops.export_scene.gltf(filepath=PATH, export_format='GLB')
document, _ = parse_glb(open(PATH, 'rb').read())
assert document.get('meshes'), 'the exported GLB has no mesh'
bpy.ops.wm.read_factory_settings(use_empty=True)
objects = load(PATH)
assert [item for item in objects if item.type == 'MESH'], 'the GLB came back without a mesh'
print(f'blender smoke ok: {bpy.app.version_string}, {len(objects)} objects, {sha(PATH)[:12]}')
