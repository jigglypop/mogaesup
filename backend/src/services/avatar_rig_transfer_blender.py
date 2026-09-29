"""Bind a preserved generated body to a saved Meshy rig and its existing clips."""
import json
from pathlib import Path
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.services.avatar_blender_common import load, skeleton, body_meshes, bounds, bind, export, sha
from src.services.glb import parse_glb


def run(payload):
    output = Path(payload['output'])
    for name in ('body', 'donor'):
        if sha(payload[name]) != payload[name+'_sha256']:
            raise ValueError('Saved rig transfer input changed')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    donor_objects = load(payload['donor'])
    rig = skeleton(donor_objects)
    rig.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    donor_body = body_meshes(donor_objects, rig)
    additions = load(payload['body'])
    body = [obj for obj in additions if obj.type == 'MESH']
    if not body or any(obj.type == 'ARMATURE' for obj in additions):
        raise ValueError('An unrigged generated body is required')
    lo, hi = bounds(body)
    target_lo, target_hi = bounds(donor_body)
    if hi.z-lo.z <= 1e-6:
        raise ValueError('Body height is missing')
    scale = (target_hi.z-target_lo.z)/(hi.z-lo.z)
    foot_center = Vector(((lo.x+hi.x)/2, (lo.y+hi.y)/2, lo.z))
    target_center = Vector(((target_lo.x+target_hi.x)/2, (target_lo.y+target_hi.y)/2, target_lo.z))
    transform = Matrix.Translation(target_center) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-foot_center)
    report = bind(body, donor_body, rig, {'slot': 'body', 'binding': 'transfer',
                  'max_transfer_distance_m': None}, transform=transform)
    for index, obj in enumerate(body):
        obj.name = f'body_{index}'
        obj['part_role'] = 'body'
    for obj in donor_body:
        bpy.data.objects.remove(obj, do_unlink=True)
    ancestors = []
    parent = rig.parent
    while parent:
        ancestors.append(parent)
        parent = parent.parent
    rig.data.pose_position = 'POSE'
    export(output/'model.glb', [*ancestors, rig, *body])
    bpy.ops.wm.save_as_mainfile(filepath=str(output/'master.blend'))
    doc, _ = parse_glb((output/'model.glb').read_bytes(), strict=True)
    if not doc.get('skins'):
        raise ValueError('Transferred body has no saved skin')
    result = {'bone_count': len(rig.data.bones), 'uniform_scale': scale,
              'body_geometry': 'generated_body_preserved_with_uniform_metric_scale',
              'binding': report, 'visual_review': 'required',
              'clips': [{'slot': clip.get('name', f'clip_{index}'),
                         'source': 'transferred_meshy_rig', 'action_id': None}
                        for index, clip in enumerate(doc.get('animations', []))]}
    (output/'complete.json').write_text(json.dumps({'input_sha256': sha(output/'input.json'),
        'files': {name: sha(output/name) for name in ('model.glb', 'master.blend')}, 'result': result}), encoding='utf8')


if __name__ == '__main__':
    run(json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text(encoding='utf8')))
