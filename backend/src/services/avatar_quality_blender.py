"""Comparison metrics for one assembled character; never a pass/fail gate.

Run inside Blender: blender --background --python avatar_quality_blender.py -- input.json
input.json: {"directory": assembly folder with body.glb and part GLBs, "output": metrics.json,
             "images": optional {slot: {view: canvas PNG}}, "canvas": optional canvas contract}
"""
import json
import math
from pathlib import Path
import sys

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.services.avatar_blender_common import load, skeleton, body_meshes, camera_setup, render
from src.services.avatar_shell_garment import CanvasView, body_arrays, body_tree, classify_regions

HEAD_PARTS = ('hair', 'hairFront', 'hairBack', 'hat')
GARMENTS = ('top', 'bottom', 'shoes')


class SurfaceColors:
    """Ray-castable surface of some objects that also reports the texture colour at a hit."""
    def __init__(self, objects):
        depsgraph = bpy.context.evaluated_depsgraph_get()
        vertices, faces, self.samples = [], [], []
        self.images = {}
        for obj in objects:
            evaluated = obj.evaluated_get(depsgraph)
            mesh = evaluated.to_mesh()
            offset = len(vertices)
            vertices.extend(evaluated.matrix_world @ v.co for v in mesh.vertices)
            mesh.calc_loop_triangles()
            uv = mesh.uv_layers.active.data if mesh.uv_layers.active else None
            for triangle in mesh.loop_triangles:
                faces.append(tuple(offset + i for i in triangle.vertices))
                material = mesh.materials[triangle.material_index] if triangle.material_index < len(mesh.materials) else None
                uvs = [tuple(uv[loop].uv) for loop in triangle.loops] if uv else None
                self.samples.append((self._image(material), uvs))
            evaluated.to_mesh_clear()
        self.vertices = vertices
        self.faces = faces
        self.tree = BVHTree.FromPolygons(vertices, faces, all_triangles=True) if faces else None

    def _image(self, material):
        if not material or not material.use_nodes:
            return None
        key = material.name
        if key not in self.images:
            node = next((n for n in material.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image), None)
            pixels = None
            if node:
                width, height = node.image.size
                if width and height:
                    buffer = np.empty(width*height*4, dtype=np.float32)
                    node.image.pixels.foreach_get(buffer)
                    pixels = buffer.reshape(height, width, 4)
            self.images[key] = pixels
        return key

    def cast(self, origin, direction):
        if self.tree is None:
            return None
        hit, _, index, distance = self.tree.ray_cast(origin, direction)
        if hit is None:
            return None
        return hit, distance, self.color(hit, index)

    def color(self, point, index):
        key, uvs = self.samples[index]
        pixels = self.images.get(key) if key else None
        if pixels is None or uvs is None:
            return None
        a, b, c = (Vector(self.vertices[i]) for i in self.faces[index])
        from mathutils.geometry import barycentric_transform
        weights = barycentric_transform(point, a, b, c, Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
        u = sum(w*uv[0] for w, uv in zip(weights, uvs)) % 1.
        v = sum(w*uv[1] for w, uv in zip(weights, uvs)) % 1.
        height, width = pixels.shape[:2]
        return pixels[min(int(v*height), height-1), min(int(u*width), width-1), :3]


def rear_coverage(body_data, regions, head_parts, body_objects):
    """Share of rays at the back of the head that meet hair-coloured headwear first.

    A hit on a hair mesh whose texture is closer to the body skin than to the hair
    colour (a skin-coloured scalp patch) counts as exposed.
    """
    head = body_data['positions'][regions == 'head']
    if not len(head) or not head_parts:
        return None
    hair, skin = SurfaceColors(head_parts), SurfaceColors(body_objects)
    center = Vector(head.mean(axis=0))
    radius = float(np.linalg.norm(head - head.mean(axis=0), axis=1).max())
    hits = []
    for elevation in np.radians([0, 15, 30, 45, 60]):
        for azimuth in np.radians(np.arange(-80, 81, 10)):
            # +Y is the back of the body in Blender coordinates.
            direction = Vector((math.sin(azimuth)*math.cos(elevation), math.cos(azimuth)*math.cos(elevation),
                                math.sin(elevation)))
            origin = center + direction*radius*3
            hits.append((hair.cast(origin, -direction), skin.cast(origin, -direction)))
    skin_colors = [s[2] for _, s in hits if s and s[2] is not None]
    hair_colors = [h[2] for h, _ in hits if h and h[2] is not None]
    skin_color = np.median(np.array(skin_colors), axis=0) if skin_colors else None
    hair_color = np.median(np.array(hair_colors), axis=0) if hair_colors else None
    covered = total = geometric = 0
    for hair_hit, skin_hit in hits:
        if hair_hit is None and skin_hit is None:
            continue
        total += 1
        if hair_hit is None or (skin_hit is not None and skin_hit[1] < hair_hit[1] - 1e-4):
            continue
        geometric += 1
        color = hair_hit[2]
        if (color is not None and skin_color is not None and hair_color is not None
                and np.linalg.norm(color - skin_color) < np.linalg.norm(color - hair_color)
                and np.linalg.norm(color - skin_color) < .12):
            continue  # a skin-coloured patch on the hair mesh
        covered += 1
    return {'rays': total, 'covered': covered, 'ratio': round(covered/max(total, 1), 4),
            'geometric_ratio': round(geometric/max(total, 1), 4)}


def penetration(objects, tree, depth=.002):
    inside = total = 0
    for obj in objects:
        for vertex in obj.data.vertices:
            point = obj.matrix_world @ vertex.co
            hit, normal, _, _ = tree.find_nearest(point)
            if hit is None:
                continue
            total += 1
            inside += int((point - hit).dot(normal) < -depth)
    return {'vertices': total, 'inside': inside, 'ratio': round(inside/max(total, 1), 5)}


def silhouette_iou(objects, all_meshes, images, canvas, height, floor, scratch):
    camera, _ = camera_setup(height)
    camera.data.ortho_scale = canvas['height']/canvas['pixels_per_metre']
    # Same framing as the frozen-body renders the part images were drawn on.
    center = Vector((0, 0, floor + (canvas['sole_y'] - canvas['height']/2)/canvas['pixels_per_metre']))
    result = {}
    directions = {'front': (0, -1, 0), 'side': (1, 0, 0), 'back': (0, 1, 0), 'opposite': (-1, 0, 0)}
    hidden = {obj: obj.hide_render for obj in all_meshes}
    for obj in all_meshes:
        obj.hide_render = obj not in objects
    for view, path in images.items():
        if view not in directions:
            continue
        target = scratch/f'quality-{view}.png'
        render(target, camera, center, directions[view], 512)
        rendered = CanvasView(view, target, canvas).alpha >= .5
        reference = CanvasView(view, path, canvas).alpha
        factor = max(1, reference.shape[0]//rendered.shape[0])
        reference = reference[::factor, ::factor][:rendered.shape[0], :rendered.shape[1]] >= .5
        union = (rendered | reference).sum()
        result[view] = round(float((rendered & reference).sum()/max(union, 1)), 4)
    for obj, value in hidden.items():
        obj.hide_render = value
    return result


def triangles(objects):
    return sum(sum(max(0, len(p.vertices) - 2) for p in obj.data.polygons) for obj in objects)


def run(payload):
    directory = Path(payload['directory'])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    objects = load(directory/'body.glb'); rig = skeleton(objects)
    rig.data.pose_position = 'REST'; bpy.context.view_layer.update()
    body = body_meshes(objects, rig)
    parts = {}
    for path in sorted(directory.glob('*.glb')):
        slot = path.stem
        if slot in ('body', 'model'):
            continue
        added = load(path)
        for obj in added:
            if obj.type == 'ARMATURE':
                obj.data.pose_position = 'REST'
        bpy.context.view_layer.update()
        parts[slot] = [obj for obj in added if obj.type == 'MESH' and obj.name.split('.')[0].startswith(slot)]
    data = body_arrays(body, rig)
    regions, _, marks = classify_regions(data['positions'], rig)
    tree = body_tree(data)
    metrics = {'directory': str(directory), 'parts': {}}
    head_parts = [obj for slot in HEAD_PARTS for obj in parts.get(slot, []) if slot != 'hat']
    metrics['rear_coverage'] = rear_coverage(data, regions, head_parts, body)
    for slot, meshes in parts.items():
        entry = {'triangles': triangles(meshes)}
        if slot in GARMENTS:
            entry['penetration'] = penetration(meshes, tree)
        metrics['parts'][slot] = entry
    images, canvas = payload.get('images') or {}, payload.get('canvas')
    if images and canvas:
        meshes = [obj for group in parts.values() for obj in group]
        floor = float(data['positions'][:, 2].min())
        height = float(data['positions'][:, 2].max()) - floor
        for slot, views in images.items():
            if slot in parts:
                metrics['parts'][slot]['silhouette_iou'] = silhouette_iou(
                    parts[slot], meshes + body, views, canvas, height, floor, Path(payload['output']).parent)
    Path(payload['output']).write_text(json.dumps(metrics, indent=2), encoding='utf8')


if __name__ == '__main__':
    run(json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text(encoding='utf8')))
