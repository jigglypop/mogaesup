"""Skin weights of skirts and tops by anatomical region: plain numpy, used by the Blender fitting
(avatar_blender_common.bind_skirt, gate_top_weights) and by the seal's quality gate (avatar_part_gate)."""
import heapq

import numpy as np

# A skirt hangs from the pelvis and is swung by the thighs. Bound to the pelvis alone, a midi or long skirt is pierced
# by the legs in every stride; given the legs' own skin weights it tears between them. Its waistband follows the
# pelvis; below the hip joints it passes to the upper legs, wholly SKIRT_LEG_REACH of the way down to the knees; and
# across the front and back it passes from one leg to the other between the two hip joints, so the fabric between the
# legs stretches with them instead of tearing. Measured on the audited skirts (walk and run clips), the share of the
# covered legs that came out through the skirt fell from 3-12% to 0.3-5% in the walk and from 25-46% to 2-12% in the
# run. The lower legs are left out: following the shins crumpled the hem in the walk.
SKIRT_LEG_REACH = .6


def _smoothstep(values):
    values = np.clip(values, 0., 1.)
    return values*values*(3 - 2*values)


def skirt_weights(points, left_hip, right_hip, left_knee, right_knee, *, reach=SKIRT_LEG_REACH):
    """Per skirt point ((n, 3), the rest frame the joints are given in, Z up), its weights for (pelvis, left upper
    leg, right upper leg): each row sums to 1 and changes smoothly with the point. The hips are the upper legs'
    joints, the knees the lower legs'."""
    points = np.asarray(points, float).reshape(-1, 3)
    left_hip, right_hip, left_knee, right_knee = (np.asarray(tuple(v), float)[:3]
                                                  for v in (left_hip, right_hip, left_knee, right_knee))
    centre, across = (left_hip + right_hip)/2, left_hip - right_hip
    half = float(np.linalg.norm(across))/2
    top, knee = centre[2], (left_knee[2] + right_knee[2])/2
    if half <= 1e-6 or top - knee <= 1e-6:
        raise ValueError('The skeleton has no measurable hips and knees for a skirt')
    lateral = (points - centre) @ (across/(2*half))/half   # -1 at the right hip joint, +1 at the left
    left = _smoothstep((lateral + 1)/2)
    legs = _smoothstep((top - points[:, 2])/(reach*(top - knee)))
    return np.stack([1 - legs, legs*left, legs*(1 - left)], axis=1)


# A top takes its weights from the nearest skin, but the SD head overhangs the shoulders: a puffy sleeve's top is
# nearer the jaw than the arm and took the head's weights (a plank stood up from the shoulder when the arms came
# down), and a raised hood's lower sides were nearer the arms and hung from them as strands. Each part of a top is
# found by its distance over the garment's own surface from the sleeves' ends, the hood's crown and the body below
# the armpits; it then keeps only the weights of the bones it can belong to.
TOP_TORSO, TOP_LEFT, TOP_RIGHT, TOP_HOOD = 0, 1, 2, 3
_LIMB_PARTS = ('shoulder', 'arm', 'forearm', 'hand', 'thumb', 'index', 'middle', 'ring', 'pinky',
               'upleg', 'leg', 'foot', 'toe')
SLEEVE_END_M = .03    # a sleeve's end: this far (along the arm) from its farthest point
SLEEVE_RADIUS_M = .12 # and this near the arm's line
SLEEVE_PAST_M = .06   # a top whose farthest point is not this far past the shoulder joint has no sleeves
ARMPIT_DROP_M = .1    # the torso below the armpits: this far under the shoulder joints and between them
HOOD_CROWN = .6       # a hood's crown: above this share of the head's height
GATE_KEEP_SHARE = .5  # a vertex keeping less than this share of its weight is filled from its neighbours


def top_bone_allowed(region, key):
    """Whether a top's vertex in `region` may follow the bone of bone_key `key`."""
    side = 'left' if key.startswith('left') else 'right' if key.startswith('right') else None
    limb = side is not None and key[len(side):] in _LIMB_PARTS
    if region == TOP_HOOD:
        return not limb or key[len(side):] == 'shoulder'
    if key.startswith('head'):
        return False
    if region in (TOP_LEFT, TOP_RIGHT):
        own = 'left' if region == TOP_LEFT else 'right'
        return key != 'neck' and (side is None or side == own)
    return True


def region_mask(keys, regions):
    """(n, bones) 1 where a row of `regions` (a vertex's region, -1 for none) may follow the bone of `keys`."""
    allowed = np.array([[top_bone_allowed(region, key) for key in keys] for region in range(4)], float).reshape(4, -1)
    regions = np.asarray(regions).reshape(-1)
    return np.where(regions[:, None] >= 0, allowed[np.clip(regions, 0, 3)], 1.)


def weld(points, step=1e-5):
    """Per point, one index for every point at its position (to `step`): a UV seam splits a vertex into several."""
    _, same = np.unique(np.round(np.asarray(points, float).reshape(-1, 3)/step).astype(np.int64), axis=0,
                        return_inverse=True)
    return np.asarray(same).reshape(-1)


def top_regions(points, edges, arms, head):
    """Per vertex of a top (points (n, 3) in the rest frame, Z up, arms along X; edges (m, 2) vertex pairs), its
    region: TOP_TORSO, TOP_LEFT or TOP_RIGHT sleeve, TOP_HOOD, or -1 when no part of the top is seeded at all.
    arms: {'left'/'right': (shoulder joint, hand joint)}; head: (lowest, highest) point of the head's skin. A
    vertex takes the region of the nearest seed over the garment's surface (vertices welded at UV seams); a piece
    no seed reaches takes that of the nearest region vertex."""
    points = np.asarray(points, float).reshape(-1, 3)
    seeds = np.full(len(points), -1)
    if not len(points):
        return seeds
    head_lo, head_hi = (np.asarray(tuple(value), float) for value in head)
    shoulders = []
    for region, side in ((TOP_LEFT, 'left'), (TOP_RIGHT, 'right')):
        shoulder, hand = (np.asarray(tuple(value), float) for value in arms[side])
        shoulders.append(shoulder)
        axis = hand - shoulder
        axis /= max(float(np.linalg.norm(axis)), 1e-9)
        along = (points - shoulder) @ axis
        radial = np.linalg.norm(points - shoulder - along[:, None]*axis, axis=1)
        near = radial <= SLEEVE_RADIUS_M
        if near.any() and along[near].max() >= SLEEVE_PAST_M:
            seeds[near & (along >= along[near].max() - SLEEVE_END_M)] = region
    lowest_shoulder = min(shoulder[2] for shoulder in shoulders)
    between = (points[:, 0] - shoulders[0][0])*(points[:, 0] - shoulders[1][0]) < 0
    seeds[(seeds < 0) & between & (points[:, 2] <= lowest_shoulder - ARMPIT_DROP_M)] = TOP_TORSO
    seeds[(seeds < 0) & (points[:, 2] >= head_lo[2] + HOOD_CROWN*(head_hi[2] - head_lo[2]))] = TOP_HOOD
    same = weld(points)
    count = int(same.max()) + 1
    node_points = np.zeros((count, 3)); node_points[same] = points
    label = np.full(count, -1)
    distance = np.full(count, np.inf)
    pairs = same[np.asarray(edges, np.int64).reshape(-1, 2)]
    pairs = pairs[pairs[:, 0] != pairs[:, 1]]
    pairs = np.concatenate([pairs, pairs[:, ::-1]])
    pairs = pairs[np.argsort(pairs[:, 0], kind='stable')]
    lengths = np.linalg.norm(node_points[pairs[:, 0]] - node_points[pairs[:, 1]], axis=1)
    starts = np.searchsorted(pairs[:, 0], np.arange(count + 1))
    queue = []
    for vertex in np.flatnonzero(seeds >= 0).tolist():
        node = int(same[vertex])
        if distance[node] > 0:
            distance[node], label[node] = 0., seeds[vertex]
            queue.append((0., node))
    heapq.heapify(queue)
    while queue:
        travelled, node = heapq.heappop(queue)
        if travelled > distance[node]:
            continue
        for index in range(starts[node], starts[node + 1]):
            other, step = int(pairs[index, 1]), travelled + float(lengths[index])
            if step < distance[other]:
                distance[other], label[other] = step, label[node]
                heapq.heappush(queue, (step, other))
    found = label >= 0
    if found.any() and not found.all():
        known = np.flatnonzero(found)
        for node in np.flatnonzero(~found).tolist():
            label[node] = label[known[np.argmin(((node_points[known] - node_points[node])**2).sum(axis=1))]]
    return label[same]


def gated_weights(weights, keys, regions, edges, *, smoothing=3):
    """Weights (n, bones) of a top, each row keeping only the bones top_bone_allowed for its region and summing
    to 1 again. A row left with nothing takes the mean of its neighbours' (repeatedly, over `edges`); a piece with no
    weighted neighbour follows the bone its region allows that carries the most weight in the top. The rows changed
    and their neighbours are then smoothed `smoothing` times so a region's edge does not tear, each pass again
    keeping only the bones the row's region allows (a sleeve beside a hood never takes the head back). Returns
    (weights, changed rows)."""
    weights = np.asarray(weights, float)
    mask = region_mask(keys, regions)
    gated = weights*mask
    changed = np.abs(gated - weights).sum(axis=1) > 1e-6
    total = gated.sum(axis=1)
    # A row that lost most of its weight keeps no say: what is left of it (a shoulder's tenth under a sleeve's
    # top that followed the head) is not where its neighbours go, and it is filled from them instead.
    resolved = total >= GATE_KEEP_SHARE*np.maximum(weights.sum(axis=1), 1e-12)
    gated[resolved] /= total[resolved, None]
    gated[~resolved] = 0.
    edges = np.asarray(edges, np.int64).reshape(-1, 2)
    both = np.concatenate([edges, edges[:, ::-1]])

    def allowed_only(rows, values, fallback):
        """`values` of `rows` kept to their region's bones and summing to 1; a row left with nothing keeps
        `fallback`."""
        values = values*mask[rows]
        sums = values.sum(axis=1)
        keep = sums > 1e-9
        values[keep] /= sums[keep, None]
        values[~keep] = fallback[~keep]
        return values
    for _ in range(200):
        if resolved.all():
            break
        sums = np.zeros_like(gated); counts = np.zeros(len(gated))
        usable = resolved[both[:, 1]]
        np.add.at(sums, both[usable, 0], gated[both[usable, 1]])
        np.add.at(counts, both[usable, 0], 1)
        fill = np.flatnonzero(~resolved & (counts > 0))
        if not len(fill):
            break
        # A neighbour in another region brings its own bones: only the ones this row's region allows count.
        values = allowed_only(fill, sums[fill]/counts[fill, None], np.zeros((len(fill), gated.shape[1])))
        filled = values.sum(axis=1) > 1e-9
        gated[fill[filled]] = values[filled]
        resolved[fill[filled]] = True
        if not filled.any():
            break
    if not resolved.all():
        # A piece with no weighted neighbour: of the bones its region allows, the one carrying the most weight in the
        # top (else in the transfer); with none allowed at all, the weights it was given.
        carried, given = gated.sum(axis=0), weights.sum(axis=0)
        for row in np.flatnonzero(~resolved).tolist():
            options = mask[row]*(carried if (mask[row]*carried).any() else given)
            gated[row] = 0.
            if options.any():
                gated[row, int(options.argmax())] = 1.
            else:
                gated[row] = weights[row]/max(float(weights[row].sum()), 1e-12)
    band = changed.copy()
    band[both[changed[both[:, 1]], 0]] = True
    for _ in range(smoothing):
        sums = np.zeros_like(gated); counts = np.zeros(len(gated))
        np.add.at(sums, both[:, 0], gated[both[:, 1]])
        np.add.at(counts, both[:, 0], 1)
        smooth = np.flatnonzero(band & (counts > 0))
        if len(smooth):
            gated[smooth] = allowed_only(smooth, .5*gated[smooth] + .5*sums[smooth]/counts[smooth, None],
                                         gated[smooth])
    # At most four influences, as bind() transfers them.
    if gated.shape[1] > 4:
        weakest = np.argsort(gated, axis=1)[:, :-4]
        np.put_along_axis(gated, weakest, 0., axis=1)
    gated /= np.maximum(gated.sum(axis=1, keepdims=True), 1e-12)
    return gated, changed
