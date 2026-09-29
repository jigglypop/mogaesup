"""Extract a part generated while worn on the key-coloured mannequin.

Runs inside Blender. The provider model contains the mannequin and the part as
one surface. It is registered to the frozen body (whole figure, then the head
for head parts), and faces that are mannequin-coloured on the body surface, or
inside the body, are removed. What remains is the part in the body frame, with
its provider UVs and textures.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from src.services.avatar_shell_garment import body_arrays, body_tree, classify_regions

DEFAULT_KEY_RGB = (1., 0., 1.)
HEAD_SLOTS = ('hair', 'hat', 'hairFront', 'hairBack')
FRINGE_HUE_DEG = 40.   # the key's shaded and compressed edges drift further in hue than its body
ANCHOR_HUE_DEG = 60.   # a provider's muted key stays this close to the requested hue
HOOD_VERTICES = 500    # garment surface over the head beyond this is a raised hood (or a cowl)
HOOD_BLEND_M = .04     # above the collar a hood moves from the body's registration to the head's


def join_meshes(meshes, name):
    for other in bpy.context.selected_objects:
        other.select_set(False)
    for obj in meshes:
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    joined.select_set(False)
    joined.name = name
    return joined


def mesh_arrays(obj):
    mesh = obj.data
    count = len(mesh.vertices)
    co = np.empty(count*3); mesh.vertices.foreach_get('co', co)
    mesh.calc_loop_triangles()
    tris = np.empty(len(mesh.loop_triangles)*3, dtype=np.int64)
    mesh.loop_triangles.foreach_get('vertices', tris)
    return co.reshape(-1, 3), tris.reshape(-1, 3)


def _base_color_image(material):
    if not material or not material.use_nodes:
        return None
    nodes = material.node_tree.nodes
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf and bsdf.inputs['Base Color'].is_linked:
        source = bsdf.inputs['Base Color'].links[0].from_node
        seen = set()
        while source and source.type != 'TEX_IMAGE' and source.name not in seen:
            seen.add(source.name)
            linked = [i for i in source.inputs if i.is_linked]
            source = linked[0].links[0].from_node if linked else None
        if source is not None and source.type == 'TEX_IMAGE' and source.image:
            return source.image
    return next((n.image for n in nodes if n.type == 'TEX_IMAGE' and n.image), None)


def vertex_colors(obj):
    """Average base colour per vertex from each face corner's texture sample."""
    mesh = obj.data
    count = len(mesh.vertices)
    result = np.zeros((count, 3)); weight = np.zeros(count)
    uv_layer = mesh.uv_layers.active
    if uv_layer is None:
        return None
    uv = np.empty(len(mesh.loops)*2); uv_layer.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    loop_vertex = np.empty(len(mesh.loops), dtype=np.int64); mesh.loops.foreach_get('vertex_index', loop_vertex)
    loop_material = np.zeros(len(mesh.loops), dtype=np.int64)
    for polygon in mesh.polygons:
        loop_material[polygon.loop_start:polygon.loop_start+polygon.loop_total] = polygon.material_index
    found = False
    for index, material in enumerate(mesh.materials):
        image = _base_color_image(material)
        loops = np.flatnonzero(loop_material == index)
        if image is None or not len(loops):
            continue
        width, height = image.size
        if not width or not height:
            continue
        pixels = np.empty(width*height*4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        pixels = pixels.reshape(height, width, 4)
        u = np.mod(uv[loops, 0], 1.); v = np.mod(uv[loops, 1], 1.)
        x = np.clip((u*width).astype(int), 0, width-1); y = np.clip((v*height).astype(int), 0, height-1)
        colors = pixels[y, x, :3]
        np.add.at(result, loop_vertex[loops], colors); np.add.at(weight, loop_vertex[loops], 1)
        found = True
    if not found:
        return None
    return np.divide(result, weight[:, None], out=np.zeros_like(result), where=weight[:, None] > 0)


def _hue(rgb):
    """Hue in degrees per row, 0 for greys."""
    high, low = rgb.max(axis=1), rgb.min(axis=1)
    chroma = high - low
    hue = np.zeros(len(rgb))
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    mask = chroma > 1e-6
    rmax = mask & (high == r); gmax = mask & (high == g) & ~rmax; bmax = mask & ~rmax & ~gmax
    hue[rmax] = np.mod((g - b)[rmax]/chroma[rmax], 6)
    hue[gmax] = (b - r)[gmax]/chroma[gmax] + 2
    hue[bmax] = (r - g)[bmax]/chroma[bmax] + 4
    return hue*60.


def _hue_distance(hue, reference):
    return np.abs((hue - reference + 180) % 360 - 180)


def key_likelihood(colors, key_rgb, *, faint=False, hue_deg=28., anchor=None):
    """1 for mannequin-coloured vertices: same hue family as the key, saturated, lit.

    faint also accepts the pale highlights a provider bakes onto the mannequin. anchor: the requested
    key when key_rgb is the muted colour a provider baked it as. Colours near either hue match (JPEG
    mixes the pure key into the part's own colour, magenta into grey as lavender), and never beyond
    ANCHOR_HUE_DEG of the requested hue, so a dusty-pink key never reaches brown hair or skin.
    """
    rgb = np.clip(colors, 0, 1)
    high, low = rgb.max(axis=1), rgb.min(axis=1)
    chroma = high - low
    saturation = np.divide(chroma, high, out=np.zeros_like(high), where=high > 1e-6)
    key = np.array(key_rgb, dtype=float)
    if key.max() - key.min() < 1e-6:
        return np.zeros(len(rgb))
    hue = _hue(rgb)
    matched = _hue_distance(hue, _hue(key[None])[0]) < hue_deg
    if anchor is not None:
        requested = _hue_distance(hue, _hue(np.array(anchor, dtype=float)[None])[0])
        matched = (matched | (requested < hue_deg)) & (requested < ANCHOR_HUE_DEG)
    return (matched & (saturation > (.15 if faint else .35)) & (high > .2)).astype(float)


def observed_key(colors, key_rgb, *, share=.03):
    """(key colour as the provider baked it, adapted?). Some providers (Tripo) return the pure key as a
    muted neighbour, magenta as dusty pink. Colours within 60 degrees of the key hue, faint ones too, are
    collected and their median becomes the key. The key is always chosen far from the part's own hues,
    so that window only meets the mannequin. Too few such colours keeps the requested key."""
    if colors is None or not len(colors):
        return tuple(key_rgb), False
    rgb = np.clip(colors, 0, 1)
    near = key_likelihood(rgb, key_rgb, faint=True, hue_deg=ANCHOR_HUE_DEG) > .5
    strict = key_likelihood(rgb, key_rgb) > .5
    if near.mean() < share or strict.sum() >= .5*near.sum():
        return tuple(key_rgb), False
    return tuple(float(v) for v in np.median(rgb[near], axis=0)), True


def face_key_votes(obj, key_rgb, anchor=None):
    """Per loop triangle: how many of its three corners and its centre sample the key colour.

    Seam vertices average the garment and the mannequin, so vertex colours miss the band of
    mannequin faces along a garment edge; each face's own UVs do not.
    """
    mesh = obj.data
    mesh.calc_loop_triangles()
    votes = np.zeros(len(mesh.loop_triangles), dtype=np.int64)
    uv_layer = mesh.uv_layers.active
    if uv_layer is None:
        return votes
    uv = np.empty(len(mesh.loops)*2); uv_layer.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    loops = np.empty(len(mesh.loop_triangles)*3, dtype=np.int64); mesh.loop_triangles.foreach_get('loops', loops)
    loops = loops.reshape(-1, 3)
    polygon = np.empty(len(mesh.loop_triangles), dtype=np.int64); mesh.loop_triangles.foreach_get('polygon_index', polygon)
    material_of = np.empty(len(mesh.polygons), dtype=np.int64); mesh.polygons.foreach_get('material_index', material_of)
    for index, material in enumerate(mesh.materials):
        image = _base_color_image(material)
        rows = np.flatnonzero(material_of[polygon] == index)
        if image is None or not len(rows) or not image.size[0] or not image.size[1]:
            continue
        width, height = image.size
        pixels = np.empty(width*height*4, dtype=np.float32); image.pixels.foreach_get(pixels)
        pixels = pixels.reshape(height, width, 4)
        corners = uv[loops[rows]]
        samples = np.concatenate([corners, corners.mean(axis=1, keepdims=True)], axis=1)
        x = np.clip((np.mod(samples[..., 0], 1.)*width).astype(int), 0, width-1)
        y = np.clip((np.mod(samples[..., 1], 1.)*height).astype(int), 0, height-1)
        keyed = key_likelihood(pixels[y, x, :3].reshape(-1, 3), key_rgb, faint=True, hue_deg=FRINGE_HUE_DEG, anchor=anchor)
        votes[rows] = keyed.reshape(-1, 4).sum(axis=1).astype(np.int64)
    return votes


def _dilate(mask, steps):
    grown = mask.copy()
    for _ in range(steps):
        step = grown.copy()
        step[1:] |= grown[:-1]; step[:-1] |= grown[1:]; step[:, 1:] |= grown[:, :-1]; step[:, :-1] |= grown[:, 1:]
        grown = step
    return grown


def _push_pull(rgb, valid, levels=12):
    """Colours for every texel from the nearest valid ones: average down a pyramid, fill back up."""
    pyramid = []
    colour, weight = rgb*valid[..., None], valid.astype(np.float32)
    while min(weight.shape) > 1 and len(pyramid) < levels:
        pyramid.append((colour, weight))
        height, width = weight.shape
        rows, columns = (height + 1)//2, (width + 1)//2
        colour = np.pad(colour, ((0, rows*2 - height), (0, columns*2 - width), (0, 0))).reshape(rows, 2, columns, 2, 3).sum(axis=(1, 3))
        weight = np.pad(weight, ((0, rows*2 - height), (0, columns*2 - width))).reshape(rows, 2, columns, 2).sum(axis=(1, 3))
    filled = colour/np.maximum(weight[..., None], 1e-12)
    for colour, weight in reversed(pyramid):
        height, width = weight.shape
        coarse = np.repeat(np.repeat(filled, 2, axis=0), 2, axis=1)[:height, :width]
        filled = np.where(weight[..., None] > 0, colour/np.maximum(weight[..., None], 1e-12), coarse)
    return filled


def repaint_key_texels(obj, key_rgb, anchor=None):
    """Give mannequin-coloured texels the nearest garment colour, so filtering at UV borders and
    mip levels never blends the key into the part. JPEG leaves a fringe of shifted hues around
    the key: texels within a few pixels of it go too. Returns the number of texels changed."""
    painted = 0
    for image in {_base_color_image(material) for material in obj.data.materials} - {None}:
        width, height = image.size
        if not width or not height:
            continue
        pixels = np.empty(width*height*4, dtype=np.float32); image.pixels.foreach_get(pixels)
        pixels = pixels.reshape(height, width, 4)
        colors = pixels[..., :3].reshape(-1, 3)
        key = key_likelihood(colors, key_rgb, faint=True, anchor=anchor).reshape(height, width) > .5
        if not key.any() or key.all():
            continue
        fringe = key_likelihood(colors, key_rgb, faint=True, hue_deg=FRINGE_HUE_DEG, anchor=anchor).reshape(height, width) > .5
        key = _dilate(key, 3) | (_dilate(key, 8) & fringe)
        pixels[..., :3] = np.where(key[..., None], _push_pull(pixels[..., :3], ~key), pixels[..., :3])
        image.pixels.foreach_set(pixels.reshape(-1))
        image.update(); image.pack()
        painted += int(key.sum())
    return painted


def _welded(points):
    """Vertex ids merged at UV seams (same position)."""
    _, weld = np.unique(np.round(points/1e-5).astype(np.int64), axis=0, return_inverse=True)
    return weld.reshape(-1)


def touching_components(points, triangles, member, touching):
    """member vertices whose connected member region (edges between members) holds a touching vertex."""
    weld = _welded(points)
    parent = np.arange(weld.max()+1)

    def find(i):
        root = i
        while parent[root] != root:
            root = parent[root]
        while parent[i] != root:
            parent[i], i = root, parent[i]
        return root
    joined = np.zeros(len(parent), dtype=bool); joined[weld[member]] = True
    corners = weld[triangles]
    for a, b in np.concatenate([corners[:, [0, 1]], corners[:, [1, 2]], corners[:, [2, 0]]]):
        if joined[a] and joined[b]:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb
    roots = np.array([find(i) for i in range(len(parent))])
    touched = np.unique(roots[weld[member & touching]])
    return member & np.isin(roots[weld], touched)


def enclosed_patches(points, triangles, patch, mannequin, ends, *, share=.5, largest=.02):
    """patch vertices in small connected patches (up to `largest` of the vertices) whose bordering
    vertices are mostly not mannequin: a piece of the part a drawing mislabels, not the mannequin
    reaching the part's edge. ends: vertices over the head, hands and feet; a patch mostly there
    is the mannequin showing past an opening (a foot below a cuff), never the part."""
    weld = _welded(points)
    count = weld.max()+1
    inside = np.zeros(count, bool); inside[weld[patch]] = True
    end = np.zeros(count, bool); end[weld[ends]] = True
    outside = np.zeros(count, bool); outside[weld[mannequin & ~patch]] = True
    parent = np.arange(count)

    def find(i):
        root = i
        while parent[root] != root:
            root = parent[root]
        while parent[i] != root:
            parent[i], i = root, parent[i]
        return root
    corners = weld[triangles]
    edges = np.concatenate([corners[:, [0, 1]], corners[:, [1, 2]], corners[:, [2, 0]]])
    for a, b in edges[inside[edges[:, 0]] & inside[edges[:, 1]]]:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    border = edges[inside[edges[:, 0]] != inside[edges[:, 1]]]
    border = np.where(inside[border[:, 0]][:, None], border, border[:, ::-1])  # (patch vertex, neighbour)
    roots = np.array([find(a) for a in border[:, 0]], dtype=np.int64)
    members = np.flatnonzero(inside)
    member_roots = np.array([find(i) for i in members], dtype=np.int64)
    sizes = dict(zip(*np.unique(member_roots, return_counts=True)))
    enclosed = np.zeros(count, bool)
    for root in np.unique(roots):
        neighbours = np.unique(border[roots == root, 1])
        if (sizes.get(root, 0) <= largest*count and outside[neighbours].mean() < share
                and end[members[member_roots == root]].mean() < .5):
            enclosed[root] = True
    enclosed_vertex = np.zeros(count, bool)
    enclosed_vertex[members] = enclosed[member_roots]
    return patch & enclosed_vertex[weld]


def scale_translate(source, target):
    """Best uniform scale and translation, rotation fixed (a smooth head has no yaw cue)."""
    mu_s, mu_t = source.mean(axis=0), target.mean(axis=0)
    a, b = source - mu_s, target - mu_t
    s = float((a*b).sum()/max((a*a).sum(), 1e-12))
    transform = np.eye(4); transform[:3, :3] *= s
    transform[:3, 3] = mu_t - s*mu_s
    return transform


def umeyama(source, target, *, scale=True):
    mu_s, mu_t = source.mean(axis=0), target.mean(axis=0)
    a, b = source - mu_s, target - mu_t
    covariance = b.T @ a/len(source)
    u, singular, vt = np.linalg.svd(covariance)
    correction = np.eye(3)
    if np.linalg.det(u @ vt) < 0:
        correction[2, 2] = -1
    rotation = u @ correction @ vt
    variance = (a*a).sum()/len(source)
    s = float(np.trace(np.diag(singular) @ correction)/variance) if scale and variance > 1e-12 else 1.
    transform = np.eye(4)
    transform[:3, :3] = s*rotation
    transform[:3, 3] = mu_t - s*rotation @ mu_s
    return transform


def apply(transform, points):
    return points @ transform[:3, :3].T + transform[:3, 3]


def trimmed_icp(points, tree, transform, *, iterations=30, keep=.6, max_points=6000, seed=7, rotate=True):
    """Similarity ICP against the body surface using the closest fraction of matches."""
    rng = np.random.default_rng(seed)
    sample = points if len(points) <= max_points else points[rng.choice(len(points), max_points, replace=False)]
    history = []
    for _ in range(iterations):
        moved = apply(transform, sample)
        nearest = np.empty_like(moved); distance = np.empty(len(moved))
        for i, point in enumerate(moved):
            hit, _, _, d = tree.find_nearest(Vector(point))
            nearest[i] = hit; distance[i] = d
        cutoff = np.percentile(distance, keep*100)
        inliers = distance <= cutoff
        if inliers.sum() < 12:
            break
        step = (umeyama(moved[inliers], nearest[inliers]) if rotate
                else scale_translate(moved[inliers], nearest[inliers]))
        transform = step @ transform
        history.append(float(np.median(distance[inliers])))
        if len(history) > 5 and abs(history[-2] - history[-1]) < 2e-7 and np.abs(step - np.eye(4)).max() < 1e-5:
            break
    return transform, {'iterations': len(history), 'median_inlier_m': history[-1] if history else None}


def initial_alignment(points, body_points):
    """Scale by T-pose arm span, stand on the floor, centre on the legs, face -Y."""
    rotation = np.eye(4)
    extent = np.ptp(points, axis=0)
    if extent[1] > extent[0]*1.15:
        # Arms along Y: the model faces +-X; turn it a quarter.
        rotation[:3, :3] = np.array([[0., -1., 0.], [1., 0., 0.], [0., 0., 1.]])
    turned = apply(rotation, points)
    # T-pose arms are the longest horizontal extent: align their principal axis with X.
    low = turned[:, 2].min(); height = np.ptp(turned[:, 2])
    band = turned[(turned[:, 2] > low + .3*height)]
    if len(band) > 20:
        xy = band[:, :2] - band[:, :2].mean(axis=0)
        weights = np.linalg.norm(xy, axis=1)**2
        covariance = (xy*weights[:, None]).T @ xy
        values, vectors = np.linalg.eigh(covariance)
        axis = vectors[:, int(np.argmax(values))]
        yaw = -math.atan2(axis[1], axis[0])
        if yaw > math.pi/2:
            yaw -= math.pi
        elif yaw < -math.pi/2:
            yaw += math.pi
        if abs(yaw) < math.radians(40):
            turn = np.eye(4)
            turn[:2, :2] = [[math.cos(yaw), -math.sin(yaw)], [math.sin(yaw), math.cos(yaw)]]
            rotation = turn @ rotation
            turned = apply(turn, turned)
    feet = turned[turned[:, 2] < low + .03*height]
    legs = turned[(turned[:, 2] > low + .06*height) & (turned[:, 2] < low + .2*height)]
    if len(feet) and len(legs) and feet[:, 1].mean() > legs[:, 1].mean():
        # Toes point to +Y: the model faces backwards.
        flip = np.eye(4); flip[0, 0] = flip[1, 1] = -1
        rotation = flip @ rotation
        turned = apply(flip, turned)
    scale = np.ptp(body_points[:, 0])/max(np.ptp(turned[:, 0]), 1e-9)
    transform = np.eye(4); transform[:3, :3] *= scale
    scaled = apply(transform, turned)
    body_legs = body_points[body_points[:, 2] < body_points[:, 2].min() + .2*np.ptp(body_points[:, 2])]
    legs = scaled[scaled[:, 2] < scaled[:, 2].min() + .2*np.ptp(scaled[:, 2])]
    offset = np.array([body_points[:, 0].mean() - scaled[:, 0].mean() if len(legs) == 0 else
                       body_legs[:, 0].mean() - legs[:, 0].mean(),
                       body_legs[:, 1].mean() - legs[:, 1].mean() if len(legs) else 0.,
                       body_points[:, 2].min() - scaled[:, 2].min()])
    transform[:3, 3] = offset
    return transform @ rotation


def remove_small_islands(obj, min_fraction=.01, *, hugging=None, mannequin=None, detached_m=.05,
                         residue_fraction=.1):
    """Delete small disconnected pieces. Vertices split at UV seams count as joined.

    hugging(points) -> per-vertex |distance| to the body; when given, only small
    pieces lying on the body surface (mannequin residue) are deleted, never a
    separate lock or ornament. mannequin: per-vertex residue flags (key colour, drawn
    mannequin); a piece that is mostly residue is deleted wherever it lies, up to
    residue_fraction of the faces. A small piece farther than detached_m from the
    largest piece (a speck near the floor) goes too.
    """
    mesh = obj.data
    points, _ = mesh_arrays(obj)
    if not len(mesh.polygons):
        return {'islands': 0, 'removed_islands': 0}
    weld = _welded(points)
    parent = np.arange(weld.max()+1)

    def find(i):
        root = i
        while parent[root] != root:
            root = parent[root]
        while parent[i] != root:
            parent[i], i = root, parent[i]
        return root
    polygon_vertices = [list(p.vertices) for p in mesh.polygons]
    for vertices in polygon_vertices:
        roots = [find(weld[v]) for v in vertices]
        for r in roots[1:]:
            parent[find(r)] = find(roots[0])
    labels = np.array([find(weld[vertices[0]]) for vertices in polygon_vertices])
    unique, counts = np.unique(labels, return_counts=True)
    small = set(unique[counts < max(1, min_fraction*len(polygon_vertices))].tolist())
    largest = unique[np.argmax(counts)]
    if mannequin is not None:
        for label in unique[(counts < residue_fraction*len(polygon_vertices)) & (unique != largest)]:
            members = np.unique(np.concatenate([polygon_vertices[i] for i in np.flatnonzero(labels == label)]))
            if mannequin[members].mean() > .5:
                small.add(int(label))
    if hugging is not None and small:
        distance = hugging(points)
        main = points[np.unique(np.concatenate([polygon_vertices[i] for i in np.flatnonzero(labels == largest)]))]
        step = max(1, len(main)//4000)
        main = main[::step]
        for label in list(small):
            members = np.unique(np.concatenate([polygon_vertices[i] for i in np.flatnonzero(labels == label)]))
            keyed = mannequin is not None and mannequin[members].mean() > .5
            gap = float(np.sqrt(((points[members][:, None, :] - main[None, :, :])**2).sum(axis=2).min()))
            if np.median(distance[members]) > .01 and not keyed and gap <= detached_m:
                small.discard(label)
    doomed = [i for i, label in enumerate(labels) if label in small]
    if doomed:
        edit = bmesh.new(); edit.from_mesh(mesh); edit.faces.ensure_lookup_table()
        bmesh.ops.delete(edit, geom=[edit.faces[i] for i in doomed], context='FACES')
        loose = [v for v in edit.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(edit, geom=loose, context='VERTS')
        edit.to_mesh(mesh); edit.free(); mesh.update()
    return {'islands': int(len(unique)), 'removed_islands': int(len(small))}


DRAWN_CORE, DRAWN_MARGIN, DRAWN_GARMENT, DRAWN_OUTSIDE = 2, 1, 0, -1


def drawn_classes(drawing, key_rgb, *, margin_m=.012, reach_m=.03):
    """Per pixel of a drawing: DRAWN_CORE, DRAWN_MARGIN, DRAWN_GARMENT or DRAWN_OUTSIDE.

    A provider rebuilds the mannequin and the part a little larger than drawn, so the background
    within reach_m of the figure takes the class of the nearer of the two (the part on a tie).
    Mannequin within margin_m of the part is only DRAWN_MARGIN: a hem the provider made a little
    longer than drawn is never taken. Computed once per drawing and key."""
    cached = getattr(drawing, 'drawn_classes', None)
    if cached is not None and cached[0] == tuple(key_rgb):
        return cached[1]
    from src.services.avatar_shell_garment import key_pixels
    ppm = min(drawing.ppm_x, drawing.ppm_y)
    key = key_pixels(drawing.rgba, key_rgb, fringe=0)
    part = (drawing.alpha >= .5) & ~key
    grown_key, grown_part = key.copy(), part.copy()
    for _ in range(int(round(reach_m*ppm))):
        free = ~(grown_key | grown_part)
        grown_part |= _dilate(grown_part, 1) & free
        grown_key |= _dilate(grown_key, 1) & free & ~grown_part
    classes = np.full(key.shape, DRAWN_OUTSIDE, dtype=np.int8)
    classes[grown_part] = DRAWN_GARMENT
    classes[grown_key] = DRAWN_MARGIN
    classes[grown_key & ~_dilate(part, max(3, int(round(margin_m*ppm))))] = DRAWN_CORE
    drawing.drawn_classes = (tuple(key_rgb), classes)
    return classes


def drawn_mannequin(drawing, key_rgb, points):
    """Per point, the drawn_classes() class of the pixel it projects to in a drawing."""
    classes = drawn_classes(drawing, key_rgb)
    pixels = drawing.project(points)
    x = np.clip(np.round(pixels[:, 0] - .5).astype(int), 0, drawing.width - 1)
    y = np.clip(np.round(pixels[:, 1] - .5).astype(int), 0, drawing.height - 1)
    return classes[y, x]


def extract_worn_part(meshes, body, rig, slot, *, key_rgb=None, name=None, drawings=()):
    """Return ([part object], report) in the body frame; mannequin faces removed.

    drawings: the views the provider was given, on the shared canvas. A provider can repaint the
    mannequin in other colours (Tripo turns parts of it grey); surface projecting onto the drawn
    mannequin in any view is removed as well (front for the fronts, side and back for the rest).
    """
    name = name or slot
    key_rgb = tuple(key_rgb or DEFAULT_KEY_RGB)
    drawn_key = key_rgb
    obj = join_meshes(meshes, f'{name}_worn')
    points, triangles = mesh_arrays(obj)
    if len(points) < 50:
        raise ValueError('Worn provider model has no surface')
    data = body_arrays(body, rig)
    tree = body_tree(data)
    regions, _, marks = classify_regions(data['positions'], rig)
    colors = vertex_colors(obj)
    requested = key_rgb
    key_rgb, adapted = observed_key(colors, key_rgb)
    # An adapted key is muted by definition, so it is matched with the faint thresholds throughout,
    # and only on the requested key's side of the colour wheel.
    anchor = requested if adapted else None
    key = key_likelihood(colors, key_rgb, faint=adapted, anchor=anchor) if colors is not None else np.zeros(len(points))
    keyed = key > .5
    faint = key_likelihood(colors, key_rgb, faint=True, anchor=anchor) > .5 if colors is not None else keyed
    report = {'method': 'worn_extract_v1', 'slot': slot, 'key_rgb': list(key_rgb),
              'requested_key_rgb': list(requested), 'key_adapted': bool(adapted),
              'provider_vertices': int(len(points)), 'key_vertices': int(keyed.sum())}
    transform = initial_alignment(points, data['positions'])
    use_key = keyed.sum() >= max(200, .05*len(points))
    registration_points = points[keyed] if use_key else points
    transform, whole = trimmed_icp(registration_points, tree, transform, keep=.9 if use_key else .6, iterations=80)
    report['registration'] = {'whole': whole, 'by_key_colour': bool(use_key)}
    aligned = apply(transform, points)
    triangle_region = regions[data['triangles'][:, 0]]

    def nearest_regions(points):
        found = np.empty(len(points), dtype=object)
        for i, point in enumerate(points):
            found[i] = triangle_region[tree.find_nearest(Vector(point))[2]]
        return found.astype(str)
    head_transform = np.eye(4)
    on_head = nearest_regions(aligned) == 'head'
    # A raised hood hugs the provider's head, which can be smaller than the frozen head: without
    # the head's own registration the hood would sit centimetres inside the frozen head.
    hood = slot not in HEAD_SLOTS and use_key and int((on_head & ~keyed & ~faint).sum()) >= HOOD_VERTICES
    if slot in HEAD_SLOTS or hood:
        # The provider's head can differ in size from the frozen head: refine on it alone.
        head_body = data['positions'][regions == 'head']
        head_tree = body_tree({'positions': data['positions'],
                               'triangles': data['triangles'][(regions[data['triangles']] == 'head').all(axis=1)]})
        candidates = (keyed & on_head) if use_key else (on_head & (aligned[:, 2] >= marks['collar_z']))
        if candidates.sum() >= 30 and len(head_body):
            head_transform, head = trimmed_icp(aligned[candidates], head_tree, np.eye(4),
                                               iterations=20, keep=.9 if use_key else .5, rotate=False)
            scale = float(np.cbrt(abs(np.linalg.det(head_transform[:3, :3]))))
            if not .8 <= scale <= 1.25:
                head_transform = np.eye(4); head['rejected_scale'] = scale
            report['registration']['head'] = head
            if hood:
                # The garment moves with the head only above the collar, blending in over HOOD_BLEND_M.
                blend = np.clip((aligned[:, 2] - marks['collar_z'])/HOOD_BLEND_M, 0., 1.)[:, None]
                aligned = aligned + blend*(apply(head_transform, aligned) - aligned)
                report['registration']['hood_vertices'] = int((blend[:, 0] > 0).sum())
                head_transform = np.eye(4)
            else:
                aligned = apply(head_transform, aligned)
    signed = np.empty(len(aligned)); nearest_region = np.empty(len(aligned), dtype=object)
    for i, point in enumerate(aligned):
        hit, normal, index, distance = tree.find_nearest(Vector(point))
        signed[i] = (Vector(point) - hit).dot(normal)
        nearest_region[i] = triangle_region[index]
    if use_key:
        # Hair roots slightly inside a differently shaped head are kept and pushed
        # out later; only deep interior surfaces of the head (mouth, eye sockets) are
        # removed. A garment found inside the body is pushed out, never cut.
        # Only a head part's own surface is cut inside the head: a garment's (a hood) is pushed out.
        inside_head = (signed < -.015) & (nearest_region.astype(str) == 'head')
        body_like = (keyed & (np.abs(signed) < .03)) | (inside_head & (keyed | faint if slot not in HEAD_SLOTS else True))
        # A provider rebuilds the mannequin centimetres off the frozen body (thicker
        # limbs, larger feet): key-coloured surface joined to a part that touches the
        # body is mannequin at any distance. A detached key-coloured ornament stays.
        connected = touching_components(points, triangles, keyed | faint, keyed & (np.abs(signed) < .03))
        report['connected_key_vertices'] = int((connected & ~body_like).sum())
        body_like |= connected
    else:
        body_like = (np.abs(signed) < .006) | (signed < -.004)
    if slot in HEAD_SLOTS and not use_key:
        # Without a key colour, surface left on the hands or feet is mannequin.
        body_like |= np.isin(nearest_region.astype(str), ('hand', 'foot')) & (np.abs(signed) < .03)
    front = next((drawing for drawing in drawings if drawing.name == 'front'), None)
    if drawings:
        # Near the body only: a loose garment edge swinging over the drawn mannequin is kept. A view
        # judges only the surface it shows: the back of the hair projects onto the front drawing's face.
        from mathutils.bvhtree import BVHTree
        from src.services.avatar_shell_garment import visible
        own = BVHTree.FromPolygons([Vector(p) for p in aligned], [tuple(int(i) for i in t) for t in triangles],
                                   all_triangles=True)
        # Hair lies over the head by nature, and a provider adds locks the drawing does not show.
        judged = (np.abs(signed) < .08) & ~body_like
        if slot in HEAD_SLOTS:
            judged &= nearest_region.astype(str) != 'head'
        index = np.flatnonzero(judged)
        drawn = np.zeros(len(aligned), dtype=bool); garment = np.zeros(len(aligned), dtype=bool)
        for drawing in drawings:
            shown = visible(aligned[index], np.zeros((len(index), 3)), [drawing], [own])[drawing.name]
            place = drawn_mannequin(drawing, drawn_key, aligned[index])
            drawn[index[shown & (place == DRAWN_CORE)]] = True
            garment[index[shown & (place == DRAWN_GARMENT)]] = True
        if front is not None and slot not in HEAD_SLOTS:
            # Surface no drawing shows clearly (the backs of the legs without a back view, a leg's
            # outline in the side view) is judged by the front drawing alone: the mannequin's
            # outline is the same from behind.
            open_ = index[~drawn[index] & ~garment[index]]
            drawn[open_[drawn_mannequin(front, drawn_key, aligned[open_]) == DRAWN_CORE]] = True
        # Views are drawn a little differently from each other and from the provider's model: a
        # patch the part surrounds is the part, whatever a drawing shows there.
        mislabelled = enclosed_patches(points, triangles, drawn & ~body_like, body_like,
                                       np.isin(nearest_region.astype(str), ('head', 'hand', 'foot')))
        drawn &= ~mislabelled
        report['drawing_mannequin_vertices'] = int((drawn & ~body_like).sum())
        report['drawing_patches_kept_vertices'] = int(mislabelled.sum())
        body_like |= drawn
    face_body = body_like[triangles].sum(axis=1) >= 2
    if use_key and colors is not None:
        # A face whose own texture is the key is mannequin, even where its seam vertices
        # average to the garment colour (the band left along hems and hairlines).
        key_faces = (face_key_votes(obj, key_rgb, anchor) >= 3) & (np.abs(signed)[triangles].min(axis=1) < .06)
        report['key_faces'] = int((key_faces & ~face_body).sum())
        face_body |= key_faces
    report['removed_faces'] = int(face_body.sum()); report['provider_faces'] = int(len(triangles))
    # A kept face with one mannequin corner reaches into the removed mannequin as a spike (a ragged
    # hem): that corner moves to the middle of the face's other two corners.
    corners = body_like[triangles]
    spikes = ~face_body & (corners.sum(axis=1) == 1)
    if spikes.any():
        weld = _welded(points)
        rows = triangles[spikes]
        tip = rows[np.arange(len(rows)), corners[spikes].argmax(axis=1)]
        target = np.zeros((weld.max()+1, 3)); count = np.zeros(weld.max()+1)
        np.add.at(target, weld[tip], (aligned[rows].sum(axis=1) - aligned[tip])/2)
        np.add.at(count, weld[tip], 1)
        moved = count[weld] > 0
        aligned = aligned.copy()
        aligned[moved] = target[weld[moved]]/count[weld[moved], None]
        report['spike_vertices_moved'] = int(moved.sum())
    # Write the aligned positions, then delete mannequin faces.
    mesh = obj.data
    flat = aligned.reshape(-1)
    mesh.vertices.foreach_set('co', flat)
    mesh.update()
    doomed_loop_triangles = set(np.flatnonzero(face_body).tolist())
    mesh.calc_loop_triangles()
    polygon_of_triangle = np.empty(len(mesh.loop_triangles), dtype=np.int64)
    mesh.loop_triangles.foreach_get('polygon_index', polygon_of_triangle)
    polygon_votes = {}
    for t, polygon in enumerate(polygon_of_triangle):
        votes = polygon_votes.setdefault(int(polygon), [0, 0])
        votes[0] += int(t in doomed_loop_triangles); votes[1] += 1
    doomed = {polygon for polygon, (bad, total) in polygon_votes.items() if bad*2 >= total}
    edit = bmesh.new(); edit.from_mesh(mesh)
    edit.faces.ensure_lookup_table()
    bmesh.ops.delete(edit, geom=[edit.faces[i] for i in sorted(doomed)], context='FACES')
    loose = [v for v in edit.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(edit, geom=loose, context='VERTS')
    edit.to_mesh(mesh); edit.free(); mesh.update()
    def hugging(points):
        return np.array([abs((Vector(p) - tree.find_nearest(Vector(p))[0]).length) for p in points])
    remaining = vertex_colors(obj) if use_key else None
    residue = key_likelihood(remaining, key_rgb, faint=True, anchor=anchor) > .5 if remaining is not None else None
    if front is not None and slot not in HEAD_SLOTS:
        # A small piece lying on the drawn mannequin is residue too (a limb's rim the provider made thicker).
        drawn_here = drawn_mannequin(front, drawn_key, mesh_arrays(obj)[0]) >= DRAWN_MARGIN
        residue = drawn_here if residue is None else residue | drawn_here
    report['islands'] = remove_small_islands(obj, hugging=hugging, mannequin=residue)
    if not len(mesh.polygons):
        raise ValueError('Nothing remained after removing the mannequin')
    if use_key:
        report['key_texels_repainted'] = repaint_key_texels(obj, key_rgb, anchor)
    report['part_vertices'] = len(mesh.vertices)
    report['part_faces'] = len(mesh.polygons)
    report['transform'] = [list(map(float, row)) for row in (head_transform @ transform)]
    obj.name = f'{name}_0'
    return [obj], report
