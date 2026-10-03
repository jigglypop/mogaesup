"""Stand-ins for Blender's bpy, bmesh and mathutils, enough to run the fitting workers' own logic offline.

`install(monkeypatch)` puts the fake modules in `sys.modules`, imports the named worker modules fresh and takes them
out again when the test ends, so no other test sees a module bound to the fakes. Geometry is plain numpy: a Vector is a
point, a Matrix a 4x4 (or 3x3) array, a BVH tree a brute-force nearest-triangle search over a few triangles.
"""
from __future__ import annotations

import ast
import importlib
import math
from pathlib import Path
import sys
import types

import numpy as np


def _values(value):
    return np.array([float(v) for v in value], float)


class Vector:
    __slots__ = ('_v',)

    def __init__(self, values=(0., 0., 0.)):
        self._v = _values(values)

    x = property(lambda self: float(self._v[0]), lambda self, value: self._v.__setitem__(0, value))
    y = property(lambda self: float(self._v[1]), lambda self, value: self._v.__setitem__(1, value))
    z = property(lambda self: float(self._v[2]), lambda self, value: self._v.__setitem__(2, value))

    def __len__(self):
        return len(self._v)

    def __iter__(self):
        return iter(float(v) for v in self._v)

    def __getitem__(self, index):
        return float(self._v[index])

    def __setitem__(self, index, value):
        self._v[index] = value

    def __add__(self, other):
        return Vector(self._v + _values(other))

    __radd__ = __add__

    def __sub__(self, other):
        return Vector(self._v - _values(other))

    def __rsub__(self, other):
        return Vector(_values(other) - self._v)

    def __neg__(self):
        return Vector(-self._v)

    def __mul__(self, factor):
        return Vector(self._v*float(factor))

    __rmul__ = __mul__

    def __truediv__(self, factor):
        return Vector(self._v/float(factor))

    def dot(self, other):
        return float(self._v @ _values(other))

    def cross(self, other):
        return Vector(np.cross(self._v, _values(other)))

    @property
    def length(self):
        return float(np.linalg.norm(self._v))

    def normalized(self):
        length = self.length
        return Vector(self._v/length if length else self._v)

    def lerp(self, other, factor):
        return Vector(self._v + (_values(other) - self._v)*float(factor))

    def rotation_difference(self, other):
        """The rotation taking this direction to `other` (Rodrigues), as an object with to_matrix()."""
        a, b = self.normalized()._v, Vector(other).normalized()._v
        axis, cosine = np.cross(a, b), float(a @ b)
        skew = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
        rotation = np.eye(3) + skew + skew @ skew/(1 + cosine) if cosine > -1 + 1e-9 else -np.eye(3)
        return types.SimpleNamespace(to_matrix=lambda: Matrix(rotation))

    def to_track_quat(self, track, up):
        return types.SimpleNamespace(to_euler=lambda: (0., 0., 0.))

    def copy(self):
        return Vector(self._v)

    def __repr__(self):
        return f'Vector({tuple(self)})'


class Matrix:
    def __init__(self, rows=None):
        self._m = np.array(rows, float) if rows is not None else np.eye(4)

    @classmethod
    def Identity(cls, size):
        return cls(np.eye(size))

    @classmethod
    def Translation(cls, vector):
        matrix = np.eye(4); matrix[:3, 3] = _values(vector)[:3]
        return cls(matrix)

    @classmethod
    def Scale(cls, factor, size, axis=None):
        matrix = np.eye(size)*float(factor)
        if size == 4:
            matrix[3, 3] = 1.
        return cls(matrix)

    @classmethod
    def Diagonal(cls, values):
        return cls(np.diag(_values(values)))

    @classmethod
    def Rotation(cls, angle, size, axis):
        c, s = math.cos(angle), math.sin(angle)
        rotation = {'X': [[1, 0, 0], [0, c, -s], [0, s, c]], 'Y': [[c, 0, s], [0, 1, 0], [-s, 0, c]],
                    'Z': [[c, -s, 0], [s, c, 0], [0, 0, 1]]}[axis]
        matrix = np.eye(size); matrix[:3, :3] = rotation
        return cls(matrix)

    def __matmul__(self, other):
        if isinstance(other, Matrix):
            return Matrix(self._m @ other._m)
        vector = _values(other)
        if self._m.shape == (4, 4) and len(vector) == 3:
            return Vector((self._m @ np.append(vector, 1.))[:3])
        return Vector(self._m @ vector)

    def __getitem__(self, index):
        return self._m[index]   # a row view: matrix[i][j] = value writes through

    def __iter__(self):
        return iter(self._m)

    def __len__(self):
        return len(self._m)

    def __array__(self, dtype=None, copy=None):
        return np.array(self._m, dtype=dtype)

    def inverted(self):
        return Matrix(np.linalg.inv(self._m))

    def to_3x3(self):
        return Matrix(self._m[:3, :3])

    def transposed(self):
        return Matrix(self._m.T)

    def copy(self):
        return Matrix(self._m)

    @property
    def translation(self):
        return Vector(self._m[:3, 3])

    @translation.setter
    def translation(self, value):
        self._m[:3, 3] = _values(value)


def _closest_on_triangle(p, a, b, c):
    """The point of triangle abc nearest p (Ericson, Real-Time Collision Detection 5.1.5)."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = ab @ ap, ac @ ap
    if d1 <= 0 and d2 <= 0:
        return a
    bp = p - b
    d3, d4 = ab @ bp, ac @ bp
    if d3 >= 0 and d4 <= d3:
        return b
    vc = d1*d4 - d3*d2
    if vc <= 0 and d1 >= 0 and d3 <= 0:
        return a + ab*(d1/(d1 - d3))
    cp = p - c
    d5, d6 = ab @ cp, ac @ cp
    if d6 >= 0 and d5 <= d6:
        return c
    vb = d5*d2 - d1*d6
    if vb <= 0 and d2 >= 0 and d6 <= 0:
        return a + ac*(d2/(d2 - d6))
    va = d3*d6 - d5*d4
    if va <= 0 and (d4 - d3) >= 0 and (d5 - d6) >= 0:
        return b + (c - b)*((d4 - d3)/((d4 - d3) + (d5 - d6)))
    denominator = 1/(va + vb + vc)
    return a + ab*(vb*denominator) + ac*(vc*denominator)


class BVHTree:
    def __init__(self, points, triangles):
        self.points = [_values(point) for point in points]
        self.triangles = [tuple(triangle) for triangle in triangles]

    @classmethod
    def FromPolygons(cls, points, polygons, all_triangles=False, epsilon=0.):
        return cls(points, polygons)

    def find_nearest(self, point, distance=1e30):
        p, best = _values(point), None
        for index, (i, j, k) in enumerate(self.triangles):
            a, b, c = self.points[i], self.points[j], self.points[k]
            q = _closest_on_triangle(p, a, b, c)
            gap = float(np.linalg.norm(p - q))
            if best is None or gap < best[3]:
                normal = np.cross(b - a, c - a)
                best = (q, normal/(np.linalg.norm(normal) or 1.), index, gap)
        if best is None:
            return None, None, None, None
        return Vector(best[0]), Vector(best[1]), best[2], best[3]


def barycentric_transform(point, a, b, c, target_a, target_b, target_c):
    p, a, b, c = (_values(v) for v in (point, a, b, c))
    v0, v1, v2 = b - a, c - a, p - a
    d00, d01, d11, d20, d21 = v0 @ v0, v0 @ v1, v1 @ v1, v2 @ v0, v2 @ v1
    denominator = d00*d11 - d01*d01
    v = (d11*d20 - d01*d21)/denominator if denominator else 0.
    w = (d00*d21 - d01*d20)/denominator if denominator else 0.
    return Vector((1 - v - w)*_values(target_a) + v*_values(target_b) + w*_values(target_c))


# Scene objects ---------------------------------------------------------------------------------------------------


class Entry:
    def __init__(self, group, weight):
        self.group, self.weight = group, weight


class Vertex:
    def __init__(self, index, co):
        self.index, self.co, self.groups = index, Vector(co), []


class Mesh:
    def __init__(self, points, triangles=()):
        self.vertices = [Vertex(index, point) for index, point in enumerate(points)]
        self._triangles = [tuple(triangle) for triangle in triangles]
        self.loop_triangles = []
        self.polygons = []
        self.materials = []
        self.shape_keys = None
        self.users = 1

    def calc_loop_triangles(self):
        self.loop_triangles = [types.SimpleNamespace(vertices=triangle) for triangle in self._triangles]

    def transform(self, matrix, shape_keys=False):
        for vertex in self.vertices:
            vertex.co = matrix @ vertex.co

    def update(self):
        pass


class VertexGroup:
    def __init__(self, owner, index, name):
        self.owner, self.index, self.name = owner, index, name

    def add(self, indices, weight, kind):
        for index in indices:
            groups = self.owner.data.vertices[index].groups
            groups[:] = [entry for entry in groups if entry.group != self.index] + [Entry(self.index, weight)]

    def remove(self, indices):
        for index in indices:
            groups = self.owner.data.vertices[index].groups
            groups[:] = [entry for entry in groups if entry.group != self.index]


class VertexGroups(list):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner

    def new(self, name):
        group = VertexGroup(self.owner, len(self), name)
        self.append(group)
        return group

    def clear(self):
        for vertex in getattr(self.owner.data, 'vertices', []):
            vertex.groups = []
        super().clear()


class Modifiers(list):
    def new(self, name, kind):
        modifier = types.SimpleNamespace(name=name, type=kind, object=None)
        self.append(modifier)
        return modifier


class Object:
    """A scene object; like Blender's, a removed one raises ReferenceError when its name is read."""

    def __init__(self, scene, name, kind, data=None, *, matrix_world=None, parent=None):
        self._scene, self._name, self.type, self.data = scene, name, kind, data
        self.matrix_world = matrix_world or Matrix.Identity(4)
        self.parent, self.hide_render, self.removed = parent, False, False
        self.modifiers, self.vertex_groups, self._properties = Modifiers(), VertexGroups(self), {}
        self.animation_data = None
        scene.objects.link(self)

    @property
    def name(self):
        if self.removed:
            raise ReferenceError('StructRNA of type Object has been removed')
        return self._name

    @name.setter
    def name(self, value):
        self._name = value

    def __getitem__(self, key):
        return self._properties[key]

    def __setitem__(self, key, value):
        self._properties[key] = value

    def get(self, key, default=None):
        return self._properties.get(key, default)

    def select_set(self, value):
        pass


class Objects:
    def __init__(self):
        self.items = []

    def link(self, obj):
        self.items.append(obj)

    def keys(self):
        return [obj.name for obj in self.items]

    def __getitem__(self, name):
        return next(obj for obj in self.items if obj.name == name)

    def __contains__(self, name):
        return any(obj.name == name for obj in self.items)

    def __iter__(self):
        return iter(self.items)

    def remove(self, obj, do_unlink=True):
        self.items.remove(obj)
        obj.removed = True


class Bones(list):
    def __contains__(self, name):
        return any(bone.name == name for bone in self)

    def get(self, name, default=None):
        return next((bone for bone in self if bone.name == name), default)

    def __getitem__(self, key):
        if isinstance(key, str):
            return next(bone for bone in self if bone.name == key)
        return super().__getitem__(key)


def bone(name, head=(0., 0., 0.), parent=None):
    return types.SimpleNamespace(name=name, parent=parent, head_local=Vector(head),
                                 matrix_local=Matrix.Translation(head), children_recursive=[])


class Scene:
    def __init__(self):
        self.objects = Objects()
        self.cycles = types.SimpleNamespace(use_denoising=True, samples=8)
        self.frames = []

    def frame_set(self, frame, subframe=0.):
        self.frames.append(frame)


def armature(scene, name, bones, *, matrix_world=None):
    rig = Object(scene, name, 'ARMATURE', types.SimpleNamespace(bones=Bones(bones), pose_position='POSE'),
                 matrix_world=matrix_world)
    rig.pose = types.SimpleNamespace(bones=[])
    return rig


def mesh(scene, name, points, triangles=(), *, rig=None, weights=None):
    """A mesh object; with `rig` it is skinned like an imported body: an armature modifier and `weights`, one
    {bone: weight} row per vertex."""
    obj = Object(scene, name, 'MESH', Mesh(points, triangles))
    if rig is not None:
        obj.modifiers.new('Armature', 'ARMATURE').object = rig
        groups = {}
        for index, row in enumerate(weights or []):
            for bone_name, weight in row.items():
                if bone_name not in groups:
                    groups[bone_name] = obj.vertex_groups.new(name=bone_name)
                groups[bone_name].add([index], weight, 'REPLACE')
    return obj


SERVICES = Path(__file__).resolve().parents[1]/'src'/'services'


def imported_services(module):
    """The src.services modules `module` imports anywhere in it, and theirs, itself included."""
    seen, todo = set(), [module]
    while todo:
        current = todo.pop()
        if current in seen or not (SERVICES/f'{current}.py').is_file():
            continue
        seen.add(current)
        for node in ast.walk(ast.parse((SERVICES/f'{current}.py').read_text(encoding='utf-8'))):
            if isinstance(node, ast.ImportFrom) and node.level == 0 and (node.module or '').startswith('src.services.'):
                todo.append(node.module.rsplit('.', 1)[-1])
            elif isinstance(node, ast.Import):
                todo.extend(alias.name.rsplit('.', 1)[-1] for alias in node.names if alias.name.startswith('src.services.'))
    return seen


def install(monkeypatch, *modules):
    """Fake Blender modules in sys.modules, a fresh scene in `bpy.context`, and `modules` imported fresh against them,
    with every service module they import: each is put back as it was (or removed) when the test ends.
    Returns (bpy, {module name: module})."""
    scene = Scene()
    bpy = types.ModuleType('bpy')
    bpy.data = types.SimpleNamespace(objects=scene.objects, images=types.SimpleNamespace(load=None),
                                     materials=types.SimpleNamespace(new=None))
    bpy.context = types.SimpleNamespace(scene=scene, object=None,
                                        view_layer=types.SimpleNamespace(update=lambda: None, objects=types.SimpleNamespace(active=None)))
    bpy.ops = types.SimpleNamespace(
        wm=types.SimpleNamespace(read_factory_settings=lambda **kw: None, save_as_mainfile=lambda **kw: None),
        object=types.SimpleNamespace(mode_set=lambda **kw: None, select_all=lambda **kw: None),
        import_scene=types.SimpleNamespace(gltf=None), export_scene=types.SimpleNamespace(gltf=None),
        render=types.SimpleNamespace(render=None))
    bpy.scene = scene
    mathutils = types.ModuleType('mathutils')
    mathutils.Vector, mathutils.Matrix = Vector, Matrix
    bvhtree = types.ModuleType('mathutils.bvhtree'); bvhtree.BVHTree = BVHTree
    geometry = types.ModuleType('mathutils.geometry'); geometry.barycentric_transform = barycentric_transform
    kdtree = types.ModuleType('mathutils.kdtree'); kdtree.KDTree = type('KDTree', (), {})
    mathutils.bvhtree, mathutils.geometry, mathutils.kdtree = bvhtree, geometry, kdtree
    fakes = {'bpy': bpy, 'bmesh': types.ModuleType('bmesh'), 'mathutils': mathutils,
             'mathutils.bvhtree': bvhtree, 'mathutils.geometry': geometry, 'mathutils.kdtree': kdtree}
    for name, module in fakes.items():
        monkeypatch.setitem(sys.modules, name, module)
    services = importlib.import_module('src.services')
    for short in set().union(*(imported_services(module) for module in modules)):
        full = f'src.services.{short}'
        # Recorded first, so the teardown puts back the module that was there or removes this one.
        monkeypatch.setitem(sys.modules, full, types.ModuleType(full))
        monkeypatch.setattr(services, short, None, raising=False)
        del sys.modules[full]
    return bpy, {name: importlib.import_module(f'src.services.{name}') for name in modules}
