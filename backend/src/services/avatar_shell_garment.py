"""Garments built from the frozen body surface, sized and painted from canvas views.

Runs inside Blender. A shell starts as a copy of the body surface in the garment
region, is cut where the view silhouettes end, widened where a silhouette is
wider than the body, and painted by projecting the views. Skin weights are the
weights of the body vertices each shell vertex came from, so the garment moves
exactly with the body. Skirts are a tube lofted from the view silhouettes.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

# Direction from the surface toward each canvas camera, in Blender coordinates
# (glTF +Z front is Blender -Y; anatomical left is +X).
VIEW_CAMERA = {'front': (0., -1., 0.), 'side': (1., 0., 0.), 'back': (0., 1., 0.), 'opposite': (-1., 0., 0.)}
REGIONS = {'top': ('torso', 'arm'), 'bottom': ('torso', 'leg')}
EASE_M = .004
MAX_EXTRA_M = {'torso': .10, 'arm': .06, 'leg': .08}
TEXTURE_SIZE = 1024
GRAZING_INSET_M = .015
# Fit (품): offset from the body surface, share of the view silhouettes' widening, minimum widening.
FITS = {'tight': (.002, 0., 0.), 'normal': (EASE_M, 1., 0.), 'loose': (.010, 1., .012)}


def shape_limits(slot, shape, marks):
    """Region limits in region_parameters units from shape values, and what they resolve to.

    sleeve: 0 (none) .. 1 (wrist), along shoulder→wrist. hem: top 0 (waist) .. 1 (crotch);
    bottom 0 (short shorts, a quarter down the leg) .. 1 (ankle). Unset values keep the drawing.
    """
    joints, limits, resolved = marks['joints'], {}, {}
    sleeve, hem = shape.get('sleeve'), shape.get('hem')
    if slot == 'top' and sleeve is not None:
        for side in (1, -1):
            start, wrist = joints[('upperarm', side)][0]*side, joints[('hand', side)][0]*side
            # A sleeveless top ends before the first arm vertex.
            limits[('arm', side)] = ({'high': start - 1.} if sleeve <= 0 else
                                     {'high': start + sleeve*(wrist - start), 'low': -np.inf})
        resolved['sleeve'] = float(sleeve)
    if hem is not None and slot == 'top':
        waist = marks['thigh_z'] + .35*(marks['shoulder_z'] - marks['thigh_z'])
        crotch = marks['thigh_z'] - .02
        limits['torso'] = {'low': waist - hem*(waist - crotch)}
        resolved.update(hem=float(hem), hem_z_m=round(limits['torso']['low'], 4))
    elif hem is not None and slot == 'bottom':
        heights = []
        for side in (1, -1):
            hip, ankle = joints[('thigh', side)][2], joints[('foot', side)][2]
            heights.append(hip - (.25 + .75*hem)*(hip - ankle))
            limits[('leg', side)] = {'high': -heights[-1], 'low': -np.inf}
        resolved.update(hem=float(hem), hem_z_m=round(float(np.mean(heights)), 4))
    resolved['fit'] = shape.get('fit') or 'normal'
    return limits, resolved


def bone_category(name):
    n = name.lower().split(':')[-1]
    if 'head' in n:
        return 'head'
    if 'neck' in n:
        return 'neck'
    if any(token in n for token in ('hand', 'finger', 'thumb', 'index', 'middle', 'ring', 'pinky')):
        return 'hand'
    if 'forearm' in n or 'lowerarm' in n:
        return 'forearm'
    if 'shoulder' in n or 'clavicle' in n:
        return 'shoulder'
    if 'arm' in n:
        return 'upperarm'
    if 'toe' in n or 'foot' in n:
        return 'foot'
    if 'upleg' in n or 'thigh' in n:
        return 'thigh'
    if 'leg' in n or 'calf' in n or 'shin' in n:
        return 'shin'
    if 'hips' in n or 'pelvis' in n:
        return 'hips'
    if 'spine' in n or 'chest' in n:
        return 'spine'
    return 'other'


def bone_side(name):
    n = name.lower()
    return 1 if 'left' in n else -1 if 'right' in n else 0


def region_of(category):
    return ('arm' if category in ('shoulder', 'upperarm', 'forearm') else
            'leg' if category in ('thigh', 'shin') else
            'torso' if category in ('spine', 'hips', 'neck') else None)


def key_pixels(rgba, key_rgb, *, hue_deg=40., fringe=2):
    """Pixels of the key-coloured mannequin a worn drawing stands on, with their antialiased edge."""
    rgb = np.clip(rgba[..., :3], 0, 1)
    high, low = rgb.max(-1), rgb.min(-1)
    chroma = high - low
    saturation = np.divide(chroma, high, out=np.zeros_like(high), where=high > 1e-6)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    safe = np.where(chroma > 1e-6, chroma, 1)
    hue = np.where(high == r, np.mod((g - b)/safe, 6), np.where(high == g, (b - r)/safe + 2, (r - g)/safe + 4))*60.
    key = np.clip(np.array(key_rgb, dtype=float), 0, 1)
    kr, kg, kb = key
    kh, kc = key.max(), key.max() - key.min()
    key_hue = (np.mod((kg - kb)/kc, 6) if kh == kr else ((kb - kr)/kc + 2) if kh == kg else ((kr - kg)/kc + 4))*60.
    mask = (np.abs((hue - key_hue + 180) % 360 - 180) < hue_deg) & (saturation > .35) & (high > .3) & (chroma > 1e-6)
    for _ in range(fringe):
        grown = mask.copy()
        grown[1:] |= mask[:-1]; grown[:-1] |= mask[1:]; grown[:, 1:] |= mask[:, :-1]; grown[:, :-1] |= mask[:, 1:]
        mask = grown
    return mask


class CanvasView:
    """One canvas image with its orthographic projection. key_rgb: the mannequin colour of a worn
    drawing, cut out so only the garment remains in the silhouette."""
    def __init__(self, name, path, canvas, *, mirrored_from=None, key_rgb=None):
        self.name = name
        image = bpy.data.images.load(str(path), check_existing=False)
        width, height = image.size
        pixels = np.empty(width*height*4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        bpy.data.images.remove(image)
        # Blender stores rows bottom-up; keep row 0 at the top like the canvas.
        self.rgba = pixels.reshape(height, width, 4)[::-1].copy()
        if mirrored_from:
            self.rgba = self.rgba[:, ::-1].copy()
        if key_rgb is not None:
            self.rgba[key_pixels(self.rgba, key_rgb), 3] = 0.
        self.width, self.height = width, height
        scale_x, scale_y = width/canvas['width'], height/canvas['height']
        self.ppm_x, self.ppm_y = canvas['pixels_per_metre']*scale_x, canvas['pixels_per_metre']*scale_y
        self.cx, self.sole = canvas['center_x']*scale_x, canvas['sole_y']*scale_y
        # The body renders put the sole row at the body's lowest point, not always z=0.
        self.floor = float(canvas.get('floor_z', 0.))
        self.camera = np.array(VIEW_CAMERA[name])
        self.alpha = self.rgba[..., 3]

    def project(self, points):
        points = np.asarray(points, dtype=np.float64)
        horizontal = {'front': points[:, 0], 'side': points[:, 1],
                      'back': -points[:, 0], 'opposite': -points[:, 1]}[self.name]
        return np.stack([self.cx + horizontal*self.ppm_x, self.sole - (points[:, 2] - self.floor)*self.ppm_y], axis=1)

    def sample(self, pixels, channels):
        """Bilinear samples of `channels` at pixel centers (x, y)."""
        x = np.clip(pixels[:, 0] - .5, 0, self.width - 1.001)
        y = np.clip(pixels[:, 1] - .5, 0, self.height - 1.001)
        x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
        fx, fy = (x - x0)[:, None], (y - y0)[:, None]
        data = channels
        top = data[y0, x0]*(1-fx) + data[y0, x0+1]*fx
        bottom = data[y0+1, x0]*(1-fx) + data[y0+1, x0+1]*fx
        return top*(1-fy) + bottom*fy

    def alpha_at(self, points):
        return self.sample(self.project(points), self.alpha[..., None])[:, 0]

    def extents(self, row_or_column, center, *, vertical=False, limit=None):
        """Contiguous opaque run through `center` on one image row (or column).

        Returns (low, high) pixel coordinates, or None when center is transparent.
        `limit` stops the search that many pixels from center on each side.
        """
        line = self.alpha[:, int(row_or_column)] if vertical else self.alpha[int(row_or_column)]
        size = len(line)
        center = int(round(center))
        if not 0 <= int(row_or_column) < (self.width if vertical else self.height) or not 0 <= center < size:
            return None
        opaque = line >= .5
        if not opaque[center]:
            return None
        span = size if limit is None else int(limit)
        low = center
        while low > 0 and center-low < span and opaque[low-1]:
            low -= 1
        high = center
        while high < size-1 and high-center < span and opaque[high+1]:
            high += 1
        return low, high, center-low >= span, high-center >= span


def body_arrays(body, rig):
    """World-space rest surface of the body meshes with dense skin weights."""
    bones = [bone.name for bone in rig.data.bones]
    index = {name: i for i, name in enumerate(bones)}
    positions, normals, triangles, weights = [], [], [], []
    offset = 0
    for obj in body:
        mesh = obj.data
        matrix = obj.matrix_world
        rotation = matrix.to_3x3().inverted().transposed()
        count = len(mesh.vertices)
        co = np.empty(count*3); mesh.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        m = np.array(matrix)
        positions.append(co @ m[:3, :3].T + m[:3, 3])
        normal = np.empty(count*3); mesh.vertices.foreach_get('normal', normal)
        normal = normal.reshape(-1, 3) @ np.array(rotation).T
        normals.append(normal/np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-12))
        mesh.calc_loop_triangles()
        tris = np.empty(len(mesh.loop_triangles)*3, dtype=np.int64)
        mesh.loop_triangles.foreach_get('vertices', tris)
        triangles.append(tris.reshape(-1, 3) + offset)
        dense = np.zeros((count, len(bones)))
        groups = {group.index: index.get(group.name) for group in obj.vertex_groups}
        for vertex in mesh.vertices:
            for entry in vertex.groups:
                column = groups.get(entry.group)
                if column is not None:
                    dense[vertex.index, column] += entry.weight
        totals = dense.sum(axis=1, keepdims=True)
        weights.append(np.divide(dense, totals, out=np.zeros_like(dense), where=totals > 1e-8))
        offset += count
    positions = np.concatenate(positions); normals = np.concatenate(normals)
    triangles = np.concatenate(triangles); weights = np.concatenate(weights)
    # glTF import keeps vertices split at UV seams; share one normal per position.
    keys = np.round(positions/1e-5).astype(np.int64)
    _, weld, inverse_counts = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
    weld = weld.reshape(-1)
    summed = np.zeros((weld.max()+1, 3)); np.add.at(summed, weld, normals)
    welded = summed[weld]
    welded /= np.maximum(np.linalg.norm(welded, axis=1, keepdims=True), 1e-12)
    return {'positions': positions, 'normals': welded, 'triangles': triangles, 'weights': weights,
            'bones': bones, 'weld': weld}


def _vertex_neighbors(triangles, count):
    edges = np.concatenate([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]])
    edges = np.concatenate([edges, edges[:, ::-1]])
    return edges[:, 0], edges[:, 1]


def smooth_scalar(values, triangles, weld, iterations=2):
    """Laplacian smoothing on welded positions; duplicates share one value."""
    groups = weld.max()+1
    value = np.zeros(groups); counts = np.zeros(groups)
    np.add.at(value, weld, values); np.add.at(counts, weld, 1)
    value /= np.maximum(counts, 1)
    a, b = _vertex_neighbors(weld[triangles], groups)
    for _ in range(iterations):
        total = np.zeros(groups); number = np.zeros(groups)
        np.add.at(total, a, value[b]); np.add.at(number, a, 1)
        value = np.where(number > 0, .5*value + .5*total/np.maximum(number, 1), value)
    return value[weld]


def body_tree(data):
    return BVHTree.FromPolygons([Vector(p) for p in data['positions']],
                                [tuple(int(i) for i in t) for t in data['triangles']], all_triangles=True)


def visible(points, normals, views, trees, lift=.002):
    """Per point and view: True when the ray toward that camera leaves the model."""
    result = {}
    for view in views:
        direction = Vector(view.camera)
        flags = np.zeros(len(points), dtype=bool)
        for i, (point, normal) in enumerate(zip(points, normals)):
            origin = Vector(point) + Vector(normal)*lift + direction*lift
            flags[i] = not any(tree.ray_cast(origin, direction, 10.)[0] is not None for tree in trees)
        result[view.name] = flags
    return result


def view_weights(normals, views, visibility, *, soft=.35):
    columns = []
    for view in views:
        facing = np.clip(normals @ view.camera + soft, 0, None)**2
        if view.name == 'opposite' and getattr(view, 'synthetic', False):
            facing *= .6
        columns.append(facing*visibility[view.name])
    return np.stack(columns, axis=1)


def coverage(data, candidate, views, trees):
    """Garment coverage per body vertex from the view silhouettes."""
    points, normals = data['positions'], data['normals']
    result = np.zeros(len(points))
    selected = np.flatnonzero(candidate)
    if not len(selected):
        return result
    visibility = visible(points[selected], normals[selected], views, trees)
    weights = view_weights(normals[selected], views, visibility, soft=0.)
    # Limb tops and bottoms face no camera; their silhouette edge is antialiased.
    # Read coverage slightly inside the limb so a sleeve has no slit along its top.
    confidence = np.max(np.stack([np.clip(normals[selected] @ view.camera, 0, 1) for view in views], axis=1), axis=1)
    inset = GRAZING_INSET_M*(1 - np.clip(confidence/.55, 0, 1))
    probe = points[selected] - normals[selected]*inset[:, None]
    samples = np.stack([view.alpha_at(probe) for view in views], axis=1)
    total = weights.sum(axis=1)
    seen = total > 1e-4
    direct = np.divide((weights*samples).sum(axis=1), total, out=np.zeros(len(selected)), where=seen)
    # Armpits, inner thighs and limb tops face no camera: use the front/back columns.
    columns = [samples[:, i] for i, view in enumerate(views) if view.name in ('front', 'back')]
    fallback = np.max(np.stack(columns, axis=1), axis=1) if columns else np.zeros(len(selected))
    result[selected] = np.where(seen, direct, fallback)
    return result


def region_parameters(positions, regions, sides, axes):
    """Coordinate along each region axis (growing away from the torso) and angle around it."""
    t = np.zeros(len(positions)); theta = np.zeros(len(positions))
    for key, axis in axes.items():
        region, side = (key, 0) if key == 'torso' else key
        mask = (regions == region) & ((sides == side) if region != 'torso' else True)
        if not mask.any():
            continue
        p = positions[mask]
        if region == 'arm':
            t[mask] = p[:, 0]*side
            theta[mask] = np.arctan2(p[:, 2] - axis[2], p[:, 1] - axis[1])
        elif region == 'leg':
            t[mask] = -p[:, 2]
            theta[mask] = np.arctan2(p[:, 1] - axis[1], p[:, 0] - axis[0])
        else:
            t[mask] = p[:, 2]
            theta[mask] = np.arctan2(p[:, 1] - axis[1], p[:, 0] - axis[0])
    return t, theta


def smooth_boundary(positions, covered, regions, sides, axes, allowed, *, bins=36, limits=None):
    """Signed distance to a hem/neckline that is smooth around each region axis.

    Raw silhouette coverage decides where each opening is; the cut follows a
    circularly smoothed boundary instead of the body's irregular triangles.
    limits {region key: {'low'|'high': t}} replace the drawing's opening there, and
    cover a region the drawing leaves open. Positive inside the garment.
    """
    t, theta = region_parameters(positions, regions, sides, axes)
    scalar = np.full(len(positions), -1.)
    for key in axes:
        region, side = (key, 0) if key == 'torso' else key
        if region not in allowed:
            continue
        mask = (regions == region) & ((sides == side) if region != 'torso' else True)
        if mask.sum() < 20:
            continue
        override = (limits or {}).get(key, {})
        inside = covered[mask] >= .5
        if inside.mean() < .02 and not override:
            continue
        tm, am = t[mask], theta[mask]
        # Thin limbs have few vertices: fewer angle bins keep each percentile stable.
        region_bins = int(np.clip(mask.sum()//12, 8, bins))
        index = np.clip(((am + np.pi)/(2*np.pi)*region_bins).astype(int), 0, region_bins-1)
        region_centers = -np.pi + (np.arange(region_bins) + .5)*2*np.pi/region_bins
        drawn = inside.mean() >= .02
        global_in = tm[inside] if drawn else tm
        lo_all, hi_all = np.percentile(global_in, 2), np.percentile(global_in, 98)
        lows, highs = np.full(region_bins, np.nan), np.full(region_bins, np.nan)
        for b in range(region_bins if drawn else 0):
            in_bin = index == b
            covered_t = tm[in_bin & inside]
            open_t = tm[in_bin & ~inside]
            if len(covered_t) < 3:
                continue
            top = np.percentile(covered_t, 97); bottom = np.percentile(covered_t, 3)
            highs[b] = top if (open_t > top).any() else np.inf
            lows[b] = bottom if (open_t < bottom).any() else -np.inf
        def fill(values, default):
            finite = np.isfinite(values)
            if not np.isnan(values).all():
                known = ~np.isnan(values)
                values = np.interp(np.arange(region_bins), np.flatnonzero(known), values[known], period=region_bins)
            else:
                values = np.full(region_bins, default)
            return values
        highs, lows = fill(highs, hi_all), fill(lows, lo_all)
        def circular_smooth(values):
            finite = np.isfinite(values)
            if not finite.any():
                return values
            padded = np.concatenate([values[-3:], values, values[:3]])
            out = values.copy()
            for b in range(region_bins):
                window = padded[b:b+7]
                window = window[np.isfinite(window)]
                if np.isfinite(values[b]) and len(window):
                    out[b] = window.mean()
            return out
        highs, lows = circular_smooth(highs), circular_smooth(lows)
        if not drawn:
            highs, lows = np.full(region_bins, np.inf), np.full(region_bins, -np.inf)
        if 'high' in override:
            highs = np.full(region_bins, float(override['high']))
        if 'low' in override:
            lows = np.full(region_bins, float(override['low']))
        def at(values):
            finite = np.isfinite(values)
            if finite.all():
                return np.interp(am, region_centers, values, period=2*np.pi)
            nearest = np.clip(((am + np.pi)/(2*np.pi)*region_bins).astype(int), 0, region_bins-1)
            result = values[nearest].astype(float)
            if finite.any():
                smooth = np.interp(am, region_centers[finite], values[finite], period=2*np.pi)
                result = np.where(np.isfinite(result), smooth, result)
            return result
        hi, lo = at(highs), at(lows)
        scalar[mask] = np.clip(np.minimum(hi - tm, tm - lo), -1., 1.)
    return scalar


def iso_cut(positions, scalar, triangles, attributes, level=.5):
    """Keep the part of the triangle mesh where scalar >= level, cut on the iso-line.

    attributes: arrays with one row per vertex, interpolated for new vertices.
    Returns (positions, triangles, attributes, parent) where parent maps each
    output vertex to (i, j, t): original vertices and the blend factor.
    """
    inside = scalar >= level
    keep = inside[triangles]
    full = triangles[keep.all(axis=1)]
    mixed = triangles[keep.any(axis=1) & ~keep.all(axis=1)]
    new_positions, new_attributes, parents = [], [[] for _ in attributes], []
    edge_index = {}
    base = len(positions)

    def cut(i, j):
        key = (min(i, j), max(i, j))
        if key in edge_index:
            return edge_index[key]
        a, b = key
        t = (level - scalar[a])/(scalar[b] - scalar[a]) if scalar[b] != scalar[a] else .5
        t = min(max(t, 0.), 1.)
        new_positions.append(positions[a]*(1-t) + positions[b]*t)
        for store, values in zip(new_attributes, attributes):
            store.append(values[a]*(1-t) + values[b]*t)
        parents.append((a, b, t))
        edge_index[key] = base + len(new_positions) - 1
        return edge_index[key]

    extra = []
    for tri in mixed:
        flags = inside[tri]
        order = list(tri)
        # Rotate so the pattern starts with the lone vertex.
        lone_inside = flags.sum() == 1
        k = int(np.flatnonzero(flags if lone_inside else ~flags)[0])
        a, b, c = order[k], order[(k+1) % 3], order[(k+2) % 3]
        if lone_inside:
            extra.append((a, cut(a, b), cut(a, c)))
        else:
            ab, ac = cut(a, b), cut(a, c)
            extra.append((ab, b, c)); extra.append((ab, c, ac))
    all_triangles = np.concatenate([full, np.array(extra, dtype=np.int64).reshape(-1, 3)])
    out_positions = np.concatenate([positions, np.array(new_positions).reshape(-1, 3)]) if new_positions else positions.copy()
    out_attributes = [np.concatenate([values, np.array(store).reshape(-1, *values.shape[1:])]) if store else values.copy()
                      for values, store in zip(attributes, new_attributes)]
    used = np.unique(all_triangles)
    remap = -np.ones(len(out_positions), dtype=np.int64); remap[used] = np.arange(len(used))
    parent = [(i, i, 0.) for i in range(len(positions))] + parents
    return (out_positions[used], remap[all_triangles], [values[used] for values in out_attributes],
            [parent[i] for i in used])


def _axis_point(rig, names, fallback):
    points = [rig.matrix_world @ rig.data.bones[name].head_local for name in names if name in rig.data.bones]
    return np.mean([list(p) for p in points], axis=0) if points else fallback


def _joints(rig):
    """First joint per (category, side): the bone of that kind nearest the root."""
    found = {}
    for bone in rig.data.bones:
        key = (bone_category(bone.name), bone_side(bone.name))
        depth, parent = 0, bone.parent
        while parent:
            depth += 1; parent = parent.parent
        if key not in found or depth < found[key][0]:
            found[key] = (depth, np.array(list(rig.matrix_world @ bone.head_local)))
    return {key: value[1] for key, value in found.items()}


def body_landmarks(positions, rig):
    """Joint heights and limb radii measured on the rest body, not bone weights.

    Auto-rigged SD bodies can weight the upper chest to Head and the belly to the
    neck, so garment regions come from geometry around these landmarks. The collar
    is where the centre cross-section suddenly deepens into the head.
    """
    joints = _joints(rig)
    need = [('upperarm', 1), ('upperarm', -1), ('hand', 1), ('hand', -1), ('thigh', 1), ('thigh', -1),
            ('foot', 1), ('foot', -1)]
    if any(key not in joints for key in need):
        raise ValueError('Body rig lacks arm, hand, thigh or foot joints for body-shell garments')
    hips = joints.get(('hips', 0), (joints[('thigh', 1)] + joints[('thigh', -1)])/2)
    shoulder_z = (joints[('upperarm', 1)][2] + joints[('upperarm', -1)][2])/2
    shoulder_x = (abs(joints[('upperarm', 1)][0]) + abs(joints[('upperarm', -1)][0]))/2
    thigh_z = (joints[('thigh', 1)][2] + joints[('thigh', -1)][2])/2
    top_z = positions[:, 2].max()
    center = np.array([hips[0], hips[1]])
    core = np.abs(positions[:, 0] - center[0]) < max(shoulder_x*1.6, .06)

    def band(z, width=.01):
        return core & (np.abs(positions[:, 2] - z) < width)

    def depth(z):
        rows = positions[band(z, .006)]
        return float(np.ptp(rows[:, 1])) if len(rows) > 3 else None
    torso_depths = [d for d in (depth(z) for z in np.arange(thigh_z + .03, shoulder_z - .02, .01)) if d]
    torso_depth = float(np.median(torso_depths)) if torso_depths else .12
    collar_z = shoulder_z + .02
    for z in np.arange(shoulder_z - .04, shoulder_z + .15, .005):
        d = depth(z)
        if d is not None and d > 1.5*torso_depth:
            collar_z = float(z) - .005
            break

    def core_radius(z0, z1):
        rows = positions[core & (positions[:, 2] > z0) & (positions[:, 2] < z1)]
        if not len(rows):
            return None
        return float(np.percentile(np.abs(rows[:, 0] - center[0]), 95))
    torso_r = core_radius(thigh_z + .02, shoulder_z - .03) or shoulder_x*1.5
    head_rows = positions[positions[:, 2] > (collar_z + top_z)/2]
    head_r = float(np.percentile(np.abs(head_rows[:, 0] - center[0]), 95)) if len(head_rows) else .25
    head_depth = float(np.percentile(np.abs(head_rows[:, 1] - center[1]), 95)) if len(head_rows) else head_r

    def limb_radius(a, b, t, reach):
        axis = b - a
        direction = axis/np.linalg.norm(axis)
        offsets = positions - (a + axis*t)
        along = offsets @ direction
        across = np.linalg.norm(offsets - np.outer(along, direction), axis=1)
        near = (np.abs(along) < .006) & (across < reach)
        return float(np.percentile(across[near], 75)) if near.sum() > 4 else None
    arm_r = limb_radius(joints[('upperarm', 1)], joints[('hand', 1)], .6, .07) or .03
    leg_r = limb_radius(joints[('thigh', 1)], joints[('foot', 1)], .5, .09) or .04
    return {'joints': joints, 'center': center, 'shoulder_z': float(shoulder_z), 'collar_z': float(collar_z),
            'thigh_z': float(thigh_z), 'top_z': float(top_z), 'torso_depth': torso_depth,
            'head_depth': max(head_depth, .05),
            'radius': {'torso': max(torso_r, .03), 'head': max(head_r, .05),
                       'arm': min(max(arm_r, .012), .07), 'leg': min(max(leg_r, .015), .09)}}


def classify_regions(positions, rig, landmarks=None):
    """Region and side per vertex from height bands and limb segments.

    Above the collar: head unless an arm segment is relatively closer. Below the
    crotch: legs and feet. Between: torso unless an arm or hand segment is
    relatively closer (distance divided by that part's measured radius).
    """
    marks = landmarks or body_landmarks(positions, rig)
    joints, radius = marks['joints'], marks['radius']
    cx, cy = marks['center']
    crotch = marks['thigh_z'] - .02

    def segment_distance(a, b, r):
        axis = b - a
        t = np.clip(((positions - a) @ axis)/max(axis @ axis, 1e-12), 0, 1)
        return np.linalg.norm(positions - (a + np.outer(t, axis)), axis=1)/r
    radial = np.linalg.norm(positions[:, :2] - np.array([cx, cy]), axis=1)
    # The head is an ellipsoid above the collar: a T-pose arm at shoulder height is
    # inside the head's width but far below its centre, so it stays an arm.
    head_center = (marks['collar_z'] + marks['top_z'])/2
    head_height = max((marks['top_z'] - marks['collar_z'])/2, .05)
    head = np.sqrt(((positions[:, 0] - cx)/radius['head'])**2 + ((positions[:, 1] - cy)/marks['head_depth'])**2
                   + ((positions[:, 2] - head_center)/head_height)**2)
    core = {'torso': radial/radius['torso'], 'head': head}
    limbs = []
    for side in (1, -1):
        shoulder, wrist = joints[('upperarm', side)], joints[('hand', side)]
        direction = (wrist - shoulder)/np.linalg.norm(wrist - shoulder)
        hand_tip = wrist + direction*max(radius['arm']*4, .06)
        hip, ankle = joints[('thigh', side)], joints[('foot', side)]
        toe = ankle + np.array([0., -max(radius['leg']*2.5, .06), -radius['leg']])
        limbs += [('arm', side, segment_distance(shoulder, wrist, radius['arm'])),
                  ('hand', side, segment_distance(wrist, hand_tip, radius['arm']*1.3)),
                  ('leg', side, segment_distance(hip, ankle, radius['leg'])),
                  ('foot', side, segment_distance(ankle, toe, radius['leg']*1.3))]
    z = positions[:, 2]
    regions = np.where(z >= marks['collar_z'], 'head', np.where(z < crotch, 'leg', 'torso')).astype(object)
    best = np.where(regions == 'head', core['head'], np.where(regions == 'torso', core['torso'], np.inf))
    sides = np.zeros(len(positions), dtype=int)
    lower = z < crotch
    for name, side, distance in limbs:
        allowed = lower if name in ('leg', 'foot') else ~lower
        better = allowed & (distance < best)
        best[better] = distance[better]; regions[better] = name; sides[better] = side
    return regions.astype(str), sides, marks


def region_axes(marks, positions, regions, sides):
    """Axis per region: torso vertical line, arms along X, legs vertical per side."""
    joints = marks['joints']
    torso = positions[regions == 'torso']
    if len(torso):
        middle = (torso[:, :2].min(axis=0) + torso[:, :2].max(axis=0))/2
        axes = {'torso': np.array([middle[0], middle[1], 0.])}
    else:
        axes = {'torso': np.array([marks['center'][0], marks['center'][1], 0.])}
    for side in (1, -1):
        axes[('arm', side)] = (joints[('upperarm', side)] + joints[('hand', side)])/2
        axes[('leg', side)] = (joints[('thigh', side)] + joints[('foot', side)])/2
    return axes


def silhouette_extras(views, data, region_ids, sides, axes, *, step=.005):
    """Per region and slice: how far each view silhouette extends past the body.

    Returns {region_key: {'param': t[], 'extra': {direction: m[]}}}. Directions:
    torso and legs '+x' '-x' '+y' '-y'; arms '+z' '-z'. A run that merges with
    another limb in the front view is unknown and filled from neighbouring slices;
    a side-view run longer than the cap is clamped to the cap.
    """
    by_name = {view.name: view for view in views}
    result = {}
    points = data['positions']
    for key in list(axes):
        region, side = (key, 0) if key == 'torso' else key
        mask = (region_ids == region) & ((sides == side) if region != 'torso' else True)
        if not mask.any():
            continue
        subset = points[mask]
        axis = axes[key]
        component = 0 if region == 'arm' else 2
        lo, hi = subset[:, component].min(), subset[:, component].max()
        samples = np.arange(lo, hi+step, step)
        limit_m = MAX_EXTRA_M[region]
        if region == 'arm':
            extra = {'+z': np.full(len(samples), np.nan), '-z': np.full(len(samples), np.nan)}
            front = by_name.get('front')
            for i, t in enumerate(samples):
                near = subset[np.abs(subset[:, 0]-t) < step]
                if front is None or not len(near):
                    continue
                column = front.project(np.array([[t, 0., axis[2]]]))[0]
                span = front.extents(column[0], column[1], vertical=True,
                                     limit=(np.ptp(near[:, 2])/2+limit_m)*front.ppm_y)
                if span is None:
                    continue
                low, high, cut_low, cut_high = span
                top_m = (front.sole - low)/front.ppm_y + front.floor
                bottom_m = (front.sole - high)/front.ppm_y + front.floor
                if not cut_low:
                    extra['+z'][i] = max(0., top_m - near[:, 2].max())
                if not cut_high:
                    extra['-z'][i] = max(0., near[:, 2].min() - bottom_m)
        else:
            extra = {name: np.full(len(samples), np.nan) for name in ('+x', '-x', '+y', '-y')}
            for i, t in enumerate(samples):
                near = subset[np.abs(subset[:, 2]-t) < step]
                if not len(near):
                    continue
                for view_name, axis_index, signs, clamp in (('front', 0, ('-x', '+x'), False),
                                                           ('side', 1, ('-y', '+y'), True)):
                    view = by_name.get(view_name)
                    if view is None:
                        continue
                    pixel = view.project(np.array([[axis[0], axis[1], t]]))[0]
                    half = np.ptp(near[:, axis_index])/2
                    span = view.extents(pixel[1], pixel[0], limit=(half+limit_m)*view.ppm_x)
                    if span is None:
                        continue
                    low, high, cut_low, cut_high = span
                    low_m, high_m = (low - view.cx)/view.ppm_x, (high - view.cx)/view.ppm_x
                    body_low, body_high = near[:, axis_index].min(), near[:, axis_index].max()
                    if region == 'leg' and view_name == 'front':
                        # A wide trouser run can join the other leg on the inner side;
                        # the outer side only meets the cap.
                        inner_low = side > 0
                        if cut_low and inner_low:
                            extra[signs[0]][i] = 0.
                        elif not cut_low or not inner_low:
                            extra[signs[0]][i] = max(0., body_low - low_m)
                        if cut_high and not inner_low:
                            extra[signs[1]][i] = 0.
                        elif not cut_high or inner_low:
                            extra[signs[1]][i] = max(0., high_m - body_high)
                        continue
                    if not cut_low or clamp:
                        extra[signs[0]][i] = max(0., body_low - low_m)
                    if not cut_high or clamp:
                        extra[signs[1]][i] = max(0., high_m - body_high)
        kernel = np.ones(5)/5
        for name, values in extra.items():
            known = np.flatnonzero(~np.isnan(values))
            values = (np.interp(np.arange(len(values)), known, values[known]) if len(known)
                      else np.zeros(len(values)))
            values = np.minimum(values, limit_m)
            extra[name] = np.convolve(np.pad(values, 2, mode='edge'), kernel, mode='valid')
        result[key] = {'param': samples, 'extra': extra}
    return result


def inflate(positions, normals, region_ids, sides, axes, extras, triangles, weld_like, marks=None, fit=FITS['normal']):
    """Offset along normals by the fit's ease, then push radially toward the silhouettes."""
    ease, share, floor = fit
    displaced = positions + normals*ease
    push = np.zeros_like(positions)
    for key, profile in extras.items():
        region, side = (key, 0) if key == 'torso' else key
        mask = (region_ids == region) & ((sides == side) if region != 'torso' else True)
        if not mask.any():
            continue
        axis = axes[key]
        subset = positions[mask]
        if region == 'arm':
            t = subset[:, 0]
            radial = subset - np.stack([subset[:, 0], np.full(len(subset), axis[1]), np.full(len(subset), axis[2])], axis=1)
            radial[:, 0] = 0
        else:
            t = subset[:, 2]
            radial = subset - np.stack([np.full(len(subset), axis[0]), np.full(len(subset), axis[1]), subset[:, 2]], axis=1)
            radial[:, 2] = 0
        length = np.linalg.norm(radial, axis=1, keepdims=True)
        radial = np.divide(radial, length, out=np.zeros_like(radial), where=length > 1e-9)
        interp = lambda name: np.interp(t, profile['param'], profile['extra'][name])
        if region == 'arm':
            vertical = np.where(radial[:, 2] > 0, interp('+z'), interp('-z'))
            depth = (interp('+z') + interp('-z'))/2
            amount = radial[:, 2]**2*vertical + radial[:, 1]**2*depth
        else:
            ex = np.where(radial[:, 0] > 0, interp('+x'), interp('-x'))
            ey = np.where(radial[:, 1] > 0, interp('+y'), interp('-y'))
            if region == 'torso' and marks:
                # Above the armpit the front silhouette belongs to the sleeve seam.
                armpit = marks['shoulder_z'] - 2.5*marks['radius']['arm']
                fade = np.clip((marks['shoulder_z'] - t)/max(marks['shoulder_z'] - armpit, 1e-6), 0, 1)
                ex = ex*fade
            amount = radial[:, 0]**2*ex + radial[:, 1]**2*ey
        amount = np.minimum(np.maximum(amount*share, floor), MAX_EXTRA_M[region])
        if region == 'leg':
            # Never push an inner thigh into the other leg.
            inward = radial[:, 0]*side < 0
            amount = np.where(inward, np.minimum(amount, .01), amount)
        push[mask] = radial*amount[:, None]
    # Blend region borders so shoulders and hips do not tear.
    for _ in range(8):
        groups = weld_like.max()+1
        summed = np.zeros((groups, 3)); counts = np.zeros(groups)
        np.add.at(summed, weld_like, push); np.add.at(counts, weld_like, 1)
        pooled = summed/np.maximum(counts, 1)[:, None]
        a, b = _vertex_neighbors(weld_like[triangles], groups)
        total = np.zeros((groups, 3)); number = np.zeros(groups)
        np.add.at(total, a, pooled[b]); np.add.at(number, a, 1)
        pooled = np.where(number[:, None] > 0, .5*pooled + .5*total/np.maximum(number, 1)[:, None], pooled)
        push = pooled[weld_like]
    return displaced + push


def skirt_loft(views, data, region_ids, axes, *, rings=64, step=.006, hem_z=None):
    """A closed tube from the waist to the hem, following front and side silhouettes.

    hem_z moves the hem; below the drawn hem the last drawn ring continues."""
    by_name = {view.name: view for view in views}
    front, side = by_name.get('front'), by_name.get('side')
    if front is None:
        raise ValueError('Skirt needs a front view')
    axis = axes['torso']
    points = data['positions']
    lower = points[np.isin(region_ids, ('torso', 'leg'))]
    column = front.project(np.array([[axis[0], axis[1], 0.]]))[0][0]
    alpha = front.alpha[:, int(round(column))] >= .5
    rows = np.flatnonzero(alpha)
    if not len(rows):
        raise ValueError('Skirt silhouette is empty at the body center')
    # The garment run that contains the hips.
    hips_row = int(round(front.sole - (axis[2] - front.floor)*front.ppm_y))
    if not alpha[min(max(hips_row, 0), len(alpha)-1)]:
        hips_row = rows[np.argmin(np.abs(rows - hips_row))]
    top, bottom = hips_row, hips_row
    while top > 0 and alpha[top-1]:
        top -= 1
    while bottom < len(alpha)-1 and alpha[bottom+1]:
        bottom += 1
    z_top = (front.sole - top)/front.ppm_y + front.floor
    drawn_bottom = z_bottom = (front.sole - bottom)/front.ppm_y + front.floor
    if hem_z is not None:
        z_bottom = min(hem_z, z_top - 2*step)
    heights = np.arange(z_top, z_bottom-1e-9, -step)
    if len(heights) < 2:
        raise ValueError('Skirt silhouette is too short')
    ring_points, drawn = [], None
    for z in heights:
        near = lower[np.abs(lower[:, 2]-z) < step]
        body_x = (near[:, 0].min()-axis[0], near[:, 0].max()-axis[0]) if len(near) else (-.05, .05)
        body_y = (near[:, 1].min()-axis[1], near[:, 1].max()-axis[1]) if len(near) else (-.05, .05)
        pixel = front.project(np.array([[axis[0], axis[1], z]]))[0]
        span = front.extents(pixel[1], pixel[0])
        if span:
            x_minus = axis[0] - (span[0] - front.cx)/front.ppm_x
            x_plus = (span[1] - front.cx)/front.ppm_x - axis[0]
        else:
            x_minus, x_plus = -body_x[0], body_x[1]
        y_minus, y_plus = -body_y[0], body_y[1]
        if side is not None:
            pixel = side.project(np.array([[axis[0], axis[1], z]]))[0]
            span = side.extents(pixel[1], pixel[0])
            if span:
                y_minus = axis[1] - (span[0] - side.cx)/side.ppm_x
                y_plus = (span[1] - side.cx)/side.ppm_x - axis[1]
        if z >= drawn_bottom - 1e-9 or drawn is None:
            drawn = (x_minus, x_plus, y_minus, y_plus)
        else:
            x_minus, x_plus, y_minus, y_plus = drawn
        x_minus = max(x_minus, -body_x[0] + EASE_M); x_plus = max(x_plus, body_x[1] + EASE_M)
        y_minus = max(y_minus, -body_y[0] + EASE_M); y_plus = max(y_plus, body_y[1] + EASE_M)
        ring = []
        for k in range(rings):
            # Seam at the back center (+Y).
            theta = math.pi/2 + 2*math.pi*k/rings
            c, s = math.cos(theta), math.sin(theta)
            ring.append((axis[0] + c*(x_plus if c > 0 else x_minus), axis[1] + s*(y_plus if s > 0 else y_minus), z))
        ring_points.append(ring)
    positions = np.array(ring_points).reshape(-1, 3)
    # Smooth each ring column along height so steps in the silhouette do not zigzag.
    grid = positions.reshape(len(heights), rings, 3)
    for _ in range(2):
        grid[1:-1, :, :2] = .25*grid[:-2, :, :2] + .5*grid[1:-1, :, :2] + .25*grid[2:, :, :2]
    positions = grid.reshape(-1, 3)
    faces = []
    for r in range(len(heights)-1):
        for k in range(rings):
            a, b = r*rings + k, r*rings + (k+1) % rings
            c, d = (r+1)*rings + (k+1) % rings, (r+1)*rings + k
            faces.append((a, d, c, b))
    return positions, faces, {'top_m': z_top, 'hem_m': z_bottom, 'drawn_hem_m': drawn_bottom,
                              'rings': rings, 'rows': len(heights)}


def component_mask(triangles, weld_like, *, min_fraction=.03):
    """Drop disconnected shell islands smaller than `min_fraction` of the triangles."""
    parent = np.arange(weld_like.max()+1)

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for a, b, c in weld_like[triangles]:
        ra, rb, rc = find(a), find(b), find(c)
        parent[rb] = ra; parent[find(rc)] = ra
    roots = np.array([find(i) for i in weld_like[triangles[:, 0]]])
    labels, counts = np.unique(roots, return_counts=True)
    large = labels[counts >= max(1, min_fraction*len(triangles))]
    return np.isin(roots, large)


def clear_body(positions, tree, minimum=.002):
    """Move shell vertices that sit inside or on the body back out by `minimum`."""
    result = positions.copy()
    for i, point in enumerate(positions):
        hit, normal, _, _ = tree.find_nearest(Vector(point))
        if hit is None:
            continue
        signed = (Vector(point) - hit).dot(normal)
        if signed < minimum:
            result[i] = np.array(hit + normal*minimum)
    return result


def create_mesh(name, positions, faces):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(p) for p in positions], [], [tuple(int(i) for i in f) for f in faces])
    mesh.validate(clean_customdata=False)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def weld_mesh(obj, distance=1e-6):
    mesh = bmesh.new(); mesh.from_mesh(obj.data)
    bmesh.ops.remove_doubles(mesh, verts=list(mesh.verts), dist=distance)
    mesh.to_mesh(obj.data); mesh.free(); obj.data.update()


def smart_uv(obj):
    for other in bpy.context.selected_objects:
        other.select_set(False)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=.004)
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.select_set(False)


def rasterize_uv(obj, size):
    """Texel centers covered by each UV triangle: (texel_index, triangle, barycentric)."""
    mesh = obj.data
    mesh.calc_loop_triangles()
    uv_layer = mesh.uv_layers.active.data
    loops = np.empty(len(mesh.loop_triangles)*3, dtype=np.int64)
    mesh.loop_triangles.foreach_get('loops', loops)
    uv = np.empty(len(uv_layer)*2); uv_layer.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)[loops].reshape(-1, 3, 2)*size
    texels, owners, barys = [], [], []
    for t, tri in enumerate(uv):
        lo = np.floor(tri.min(axis=0)).astype(int); hi = np.ceil(tri.max(axis=0)).astype(int)
        lo = np.clip(lo, 0, size-1); hi = np.clip(hi, 0, size-1)
        xs, ys = np.meshgrid(np.arange(lo[0], hi[0]+1), np.arange(lo[1], hi[1]+1))
        px = np.stack([xs.ravel()+.5, ys.ravel()+.5], axis=1)
        a, b, c = tri
        v0, v1, v2 = b-a, c-a, px-a
        d00, d01, d11 = v0@v0, v0@v1, v1@v1
        denominator = d00*d11 - d01*d01
        if abs(denominator) < 1e-12:
            continue
        d20, d21 = v2@v0, v2@v1
        w1 = (d11*d20 - d01*d21)/denominator
        w2 = (d00*d21 - d01*d20)/denominator
        w0 = 1 - w1 - w2
        inside = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
        if not inside.any():
            continue
        texels.append((ys.ravel()[inside]*size + xs.ravel()[inside]))
        owners.append(np.full(int(inside.sum()), t))
        barys.append(np.stack([w0[inside], w1[inside], w2[inside]], axis=1))
    if not texels:
        raise ValueError('Garment has no UV area')
    return np.concatenate(texels), np.concatenate(owners), np.concatenate(barys), mesh.loop_triangles


def bake_projection(obj, views, trees, *, size=TEXTURE_SIZE, name='garment'):
    """Paint the garment by projecting the canvas views onto its UV texels."""
    mesh = obj.data
    matrix = np.array(obj.matrix_world)
    count = len(mesh.vertices)
    co = np.empty(count*3); mesh.vertices.foreach_get('co', co)
    positions = co.reshape(-1, 3) @ matrix[:3, :3].T + matrix[:3, 3]
    normal = np.empty(count*3); mesh.vertices.foreach_get('normal', normal)
    normals = normal.reshape(-1, 3)
    visibility = visible(positions, normals, views, trees)
    vertex_weights = view_weights(normals, views, visibility)
    texels, owners, barys, loop_triangles = rasterize_uv(obj, size)
    tri_vertices = np.empty(len(loop_triangles)*3, dtype=np.int64)
    loop_triangles.foreach_get('vertices', tri_vertices)
    tri_vertices = tri_vertices.reshape(-1, 3)
    corners = tri_vertices[owners]
    points = np.einsum('ij,ijk->ik', barys, positions[corners])
    weights = np.einsum('ij,ijk->ik', barys, vertex_weights[corners])
    texel_normals = np.einsum('ij,ijk->ik', barys, normals[corners])
    texel_normals /= np.maximum(np.linalg.norm(texel_normals, axis=1, keepdims=True), 1e-9)
    # A surface no camera faces (the top of a T-pose sleeve) would take the colour
    # of a silhouette edge; sample slightly inside the limb instead.
    confidence = np.max(np.stack([np.clip(texel_normals @ view.camera, 0, 1) for view in views], axis=1), axis=1)
    inset = GRAZING_INSET_M*(1 - np.clip(confidence/.55, 0, 1))
    sample_points = points - texel_normals*inset[:, None]
    colors = np.zeros((len(texels), 3)); total = np.zeros(len(texels))
    for i, view in enumerate(views):
        pixels = view.project(sample_points)
        sample = view.sample(pixels, view.rgba)
        w = weights[:, i]*(sample[:, 3] >= .5)
        colors += sample[:, :3]*w[:, None]; total += w
    painted = total > 1e-6
    image = np.zeros((size*size, 4), dtype=np.float32)
    colors = np.where(painted[:, None], colors/np.maximum(total, 1e-6)[:, None], _dominant_color(views))
    if painted.any() and not painted.all():
        # No view paints a lengthened sleeve or hem (or an armpit): take the nearest painted colour.
        source = np.flatnonzero(painted)[::max(1, int(painted.sum())//200000)]
        tree = KDTree(len(source))
        for index in source:
            tree.insert(points[index], int(index))
        tree.balance()
        empty = np.flatnonzero(~painted)
        nearest = np.array([[found for _, found, _ in tree.find_n(points[index], 4)] for index in empty])
        colors[empty] = colors[nearest].mean(axis=1)
    image[texels, :3] = colors
    image[texels, 3] = 1.
    filled = np.zeros(size*size, dtype=bool); filled[texels] = True
    image = _dilate(image.reshape(size, size, 4), filled.reshape(size, size), 4)
    texture = bpy.data.images.new(f'{name}_shell', size, size, alpha=False)
    texture.pixels.foreach_set(image.reshape(-1))
    texture.pack()
    return texture, {'texels': int(len(texels)), 'painted_ratio': float(painted.mean()),
                     'views': [view.name for view in views], 'size': size}


def _dominant_color(views):
    for view in views:
        opaque = view.rgba[view.alpha >= .5]
        if len(opaque):
            return np.median(opaque[:, :3], axis=0)
    return np.array([.8, .8, .8])


def _dilate(image, filled, steps):
    """Grow painted texels into the island margins to avoid dark seams."""
    for _ in range(steps):
        grown = filled.copy(); result = image.copy()
        accum = np.zeros_like(image); counts = np.zeros(filled.shape)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted = np.roll(np.roll(image, dy, axis=0), dx, axis=1)
            mask = np.roll(np.roll(filled, dy, axis=0), dx, axis=1)
            accum += shifted*mask[..., None]; counts += mask
        new = (~filled) & (counts > 0)
        result[new] = accum[new]/counts[new][:, None]
        grown[new] = True
        image, filled = result, grown
    return image


def shell_material(texture, name):
    material = bpy.data.materials.new(f'{name}_shell')
    material.use_nodes = True
    nodes = material.node_tree.nodes
    bsdf = next(node for node in nodes if node.type == 'BSDF_PRINCIPLED')
    image = nodes.new('ShaderNodeTexImage'); image.image = texture
    material.node_tree.links.new(image.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = .8
    if 'Metallic' in bsdf.inputs:
        bsdf.inputs['Metallic'].default_value = 0.
    material.use_backface_culling = False
    return material


def assign_weights(obj, rig, bones, weights, *, rigid=None):
    obj.vertex_groups.clear()
    groups = {name: obj.vertex_groups.new(name=name) for name in bones}
    for vertex_index, row in enumerate(weights):
        if rigid:
            groups[rigid].add([vertex_index], 1., 'REPLACE')
            continue
        order = np.argsort(row)[::-1][:4]
        total = row[order].sum()
        for column in order:
            if row[column] > 1e-6 and total > 1e-8:
                groups[bones[column]].add([vertex_index], float(row[column]/total), 'REPLACE')
    modifier = obj.modifiers.new('CanonicalBodySkin', 'ARMATURE'); modifier.object = rig


def load_views(image_paths, canvas, key_rgb=None):
    views = []
    for name in ('front', 'side', 'back', 'opposite'):
        path = (image_paths or {}).get(name)
        if path:
            views.append(CanvasView(name, path, canvas, key_rgb=key_rgb))
    names = {view.name for view in views}
    if 'side' in names and 'opposite' not in names:
        view = CanvasView('opposite', image_paths['side'], canvas, mirrored_from='side', key_rgb=key_rgb)
        view.synthetic = True
        views.append(view)
    if 'front' not in names:
        raise ValueError('Body-shell garment needs a front view')
    return views


def build_shell_garment(body, rig, slot, image_paths, canvas, *, kind='source', name=None, shape=None, key_rgb=None):
    """Create one skinned garment object for `slot` from canvas views.

    shape {'sleeve', 'hem', 'fit'} overrides the drawn sleeve length, hem and ease
    (see shape_limits and FITS). Returns (objects, report, coverage). The objects are
    in world space without parents and carry the canonical armature modifier.
    """
    if slot not in REGIONS:
        raise ValueError(f'Body-shell garments support {sorted(REGIONS)}')
    name = name or slot
    data = body_arrays(body, rig)
    canvas = {**canvas, 'floor_z': float(data['positions'][:, 2].min())}
    views = load_views(image_paths, canvas, key_rgb)
    vertex_region, vertex_side, marks = classify_regions(data['positions'], rig)
    tree = body_tree(data)
    axes = region_axes(marks, data['positions'], vertex_region, vertex_side)
    report = {'method': 'body_shell_v1', 'slot': slot, 'views': [view.name for view in views],
              'skin': 'copied_from_body_vertices', 'body_vertices': int(len(data['positions'])),
              'landmarks_m': {'shoulder_z': round(marks['shoulder_z'], 4), 'collar_z': round(marks['collar_z'], 4),
                              'thigh_z': round(marks['thigh_z'], 4),
                              'radius': {k: round(v, 4) for k, v in marks['radius'].items()}}}
    objects = []
    skirt = slot == 'bottom' and kind == 'skirt'
    limits, report['shape'] = shape_limits(slot, shape or {}, marks)
    fit = FITS[report['shape']['fit']]
    candidate = np.isin(vertex_region, REGIONS[slot])
    raw = coverage(data, candidate, views, [tree])
    raw = smooth_scalar(raw, data['triangles'], data['weld'], iterations=2)
    raw[~candidate] = 0.
    boundary = smooth_boundary(data['positions'], raw, vertex_region, vertex_side, axes, REGIONS[slot], limits=limits)
    boundary = smooth_scalar(boundary, data['triangles'], data['weld'], iterations=1)
    boundary[~candidate] = -1.
    covered = (boundary >= 0).astype(float)
    report['covered_body_vertices'] = int((boundary >= 0).sum())
    tris = data['triangles']
    keep = (boundary[tris] >= 0).any(axis=1)
    if skirt:
        # Legs stay visible inside an open hem: the skirt is one lofted tube and
        # hides no body faces.
        keep[:] = False
        covered = np.zeros_like(covered)
    if keep.any():
        numeric = [data['normals'], data['weights'], vertex_side.astype(float)]
        positions, triangles, (normals, weights, sides_f), parents = iso_cut(
            data['positions'], boundary, tris[keep], numeric, level=0.)
        regions = np.array([vertex_region[i] if t < .5 else vertex_region[j] for i, j, t in parents])
        sides = np.rint(sides_f).astype(int)
        # UV-seam duplicates (and cuts on duplicated edges) share one position.
        _, weld_like = np.unique(np.round(positions/1e-5).astype(np.int64), axis=0, return_inverse=True)
        weld_like = weld_like.reshape(-1)
        normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
        extras = silhouette_extras(views, data, vertex_region, vertex_side, axes)
        positions = inflate(positions, normals, regions, sides, axes, extras, triangles, weld_like, marks, fit)
        positions = clear_body(positions, tree)
        triangles = triangles[component_mask(triangles, weld_like)]
        used = np.unique(triangles)
        remap = -np.ones(len(positions), dtype=np.int64); remap[used] = np.arange(len(used))
        positions, weights, triangles = positions[used], weights[used], remap[triangles]
        obj = create_mesh(f'{name}_shell', positions, triangles)
        assign_weights(obj, rig, data['bones'], weights)
        weld_mesh(obj)
        objects.append(obj)
        report['shell_triangles'] = int(len(triangles))
        report['silhouette_extra_max_m'] = {str(key): {d: round(float(np.max(v)), 4) for d, v in profile['extra'].items()}
                                           for key, profile in extras.items()}
    if skirt:
        positions, faces, loft = skirt_loft(views, data, vertex_region, axes, hem_z=report['shape'].get('hem_z_m'))
        obj = create_mesh(f'{name}_skirt', positions, faces)
        hips = next((bone for bone in data['bones'] if bone_category(bone) == 'hips'), None)
        if not hips:
            raise ValueError('Missing pelvis for skirt attachment')
        assign_weights(obj, rig, data['bones'], np.zeros((len(positions), len(data['bones']))), rigid=hips)
        objects.append(obj)
        report['skirt'] = loft
    if not objects:
        raise ValueError('Garment silhouette does not cover the body region')
    if len(objects) > 1:
        for other in bpy.context.selected_objects:
            other.select_set(False)
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        objects = [bpy.context.view_layer.objects.active]
    garment = objects[0]
    garment.name = f'{name}_0'
    smart_uv(garment)
    shell_tree = BVHTree.FromObject(garment, bpy.context.evaluated_depsgraph_get())
    uncovered_body = _uncovered_tree(data, covered)
    texture, paint = bake_projection(garment, views, [shell_tree] + ([uncovered_body] if uncovered_body else []), name=name)
    garment.data.materials.clear()
    garment.data.materials.append(shell_material(texture, name))
    for polygon in garment.data.polygons:
        polygon.use_smooth = True
    report['texture'] = paint
    report['triangles'] = sum(max(0, len(p.vertices)-2) for p in garment.data.polygons)
    return [garment], report, split_coverage(body, covered)


def split_coverage(body, covered):
    """Per body object: indices of vertices under the garment."""
    result, offset = {}, 0
    for obj in body:
        count = len(obj.data.vertices)
        result[obj.name] = set(np.flatnonzero(covered[offset:offset+count] >= .5).tolist())
        offset += count
    return result


def _uncovered_tree(data, covered):
    tris = data['triangles']
    open_faces = tris[(covered[tris] < .5).all(axis=1)]
    if not len(open_faces):
        return None
    return BVHTree.FromPolygons([Vector(p) for p in data['positions']],
                                [tuple(int(i) for i in t) for t in open_faces], all_triangles=True)
