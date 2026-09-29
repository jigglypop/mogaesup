"""Pre-rig limb fit of a worn garment against the frozen body and its bones.

After the mannequin is removed and before weights are transferred, each sleeve (and trouser
leg) is cut into rings along its bone. In every ring the garment's reach up/down/front/back
(front/back/left/right on a leg) is compared with the body's cross-section there. A provider
can rebuild the mannequin's arms lower or further back than the frozen T-pose, so a sleeve
sits off the arm while staying parallel to it. Centring moves each ring until the clearances
on opposite sides match, fading to nothing at the shoulder so the torso panel keeps its shape.
The same measurement after clearance is the part's fit check.
"""
import numpy as np

from src.services.avatar_shell_garment import _joints, body_arrays

RING_M = .01
MIN_RINGS = 4
RING_POINTS = 30
SECTORS, CLOSED_SECTORS = 12, 10   # a ring counts when the garment goes around the limb
SAMPLES_PER_M2 = 200000   # surface samples: a decimated sleeve has few vertices per ring
MAX_SAMPLES = 250000
CHAINS = {'arm': ('upperarm', 'hand'), 'leg': ('thigh', 'foot')}
FIRST_RING_M = {'arm': .06, 'leg': .05}   # past the torso side / the crotch
SEAM_M = {'arm': .03, 'leg': .04}         # a shift starts this far past the joint...
RAMP_M = .06                              # ...and reaches full strength over this distance
REACH_M = {'arm': (.10, .08), 'leg': (.15, .12)}   # garment and body radius around the bone line
MIN_SHIFT_M = .005
MAX_SHIFT_M = .06
FAIL_MARGIN_M = -.005
FAIL_ANGLE_DEG = 3.
NAMES = {'arm': ('왼팔', '오른팔'), 'leg': ('왼다리', '오른다리')}
DIRECTIONS = {'up': '위', 'down': '아래', 'front': '앞', 'back': '뒤', 'left': '왼', 'right': '오른'}


def _limbs(slot, garment_kind=None):
    if slot == 'top':
        return ('arm',)
    if slot == 'bottom' and garment_kind != 'skirt':
        return ('leg',)
    return ()


def _frame(kind, axis):
    """Two unit directions across the bone: (vector, positive name, negative name) each."""
    front = np.array([0., -1., 0.])
    if kind == 'arm':
        up = np.array([0., 0., 1.]) - axis*axis[2]
        up /= np.linalg.norm(up)
        across = np.cross(axis, up)
        across = across if across @ front > 0 else -across
        return (up, 'up', 'down'), (across, 'front', 'back')
    front = front - axis*(axis @ front)
    front /= np.linalg.norm(front)
    left = np.cross(front, axis)
    left = left if left[0] > 0 else -left
    return (front, 'front', 'back'), (left, 'left', 'right')


def _points(objects):
    rows = []
    for obj in objects:
        count = len(obj.data.vertices)
        co = np.empty(count*3); obj.data.vertices.foreach_get('co', co)
        matrix = np.array(obj.matrix_world)
        rows.append(co.reshape(-1, 3) @ matrix[:3, :3].T + matrix[:3, 3])
    return rows


def _surface(points, triangles, seed=0):
    """Area-uniform samples of a triangle surface."""
    a, b, c = (points[triangles[:, i]] for i in range(3))
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1)/2
    total = float(area.sum())
    if total <= 0:
        return points
    count = int(min(MAX_SAMPLES, max(len(points), total*SAMPLES_PER_M2)))
    rng = np.random.default_rng(seed)
    chosen = rng.choice(len(triangles), count, p=area/total)
    root, other = np.sqrt(rng.random(count)), rng.random(count)
    return ((1 - root)[:, None]*a[chosen] + (root*(1 - other))[:, None]*b[chosen]
            + (root*other)[:, None]*c[chosen])


def _garment_surface(objects):
    points, triangles, offset = [], [], 0
    for obj, world in zip(objects, _points(objects)):
        obj.data.calc_loop_triangles()
        corners = np.empty(len(obj.data.loop_triangles)*3, dtype=np.int64)
        obj.data.loop_triangles.foreach_get('vertices', corners)
        points.append(world); triangles.append(corners.reshape(-1, 3) + offset); offset += len(world)
    return _surface(np.concatenate(points), np.concatenate(triangles))


def _body_surface(body, rig):
    data = body_arrays(body, rig)
    return _surface(data['positions'], data['triangles'])


class _Limb:
    """One limb's bone line, cross directions and ring measurements."""

    def __init__(self, kind, side, joints):
        self.kind, self.side = kind, side
        self.root = joints[(CHAINS[kind][0], side)]
        end = joints[(CHAINS[kind][1], side)]
        self.length = float(np.linalg.norm(end - self.root))   # to the wrist / ankle
        self.axis = (end - self.root)/self.length
        self.frame = _frame(kind, self.axis)
        self.name = f"{'left' if side > 0 else 'right'}_{kind}"

    def local(self, points):
        offset = points - self.root
        t = offset @ self.axis
        radial = np.linalg.norm(offset - np.outer(t, self.axis), axis=1)
        return t, radial

    def region(self, points, reach):
        t, radial = self.local(points)
        inside = radial < reach
        if self.kind == 'leg':
            inside &= points[:, 0]*self.side > 0   # this leg's side of the midline
        return t, inside

    def rings(self, garment, body):
        g_reach, b_reach = REACH_M[self.kind]
        gt, g_in = self.region(garment, g_reach)
        bt, b_in = self.region(body, b_reach)
        if not g_in.any():
            return []
        rows = []
        # Hands and feet leave the openings by design: rings stop at the wrist / ankle.
        for start in np.arange(FIRST_RING_M[self.kind], min(gt[g_in].max(), self.length - RING_M), RING_M):
            g = garment[g_in & (gt >= start) & (gt < start + RING_M)]
            b = body[b_in & (bt >= start) & (bt < start + RING_M)]
            if len(g) < RING_POINTS or len(b) < RING_POINTS:
                continue
            centre = b.mean(axis=0)
            around = np.arctan2((g - centre) @ self.frame[1][0], (g - centre) @ self.frame[0][0])
            if len(np.unique(((around + np.pi)/(2*np.pi)*SECTORS).astype(int) % SECTORS)) < CLOSED_SECTORS:
                continue   # a slanted hem or an open sleeve: no clearance to measure here
            row = {'t': float(start + RING_M/2), 'count': int(min(len(g), len(b))), 'margins': {}}
            for vector, positive, negative in self.frame:
                reach_g, reach_b = (g - centre) @ vector, (b - centre) @ vector
                row['margins'][positive] = float(reach_g.max() - reach_b.max())
                row['margins'][negative] = float(reach_b.min() - reach_g.min())
            rows.append(row)
        return rows


def _shift_model(limb, rings):
    """Linear shift along the bone that equalises opposite clearances, or None."""
    if len(rings) < 2:
        return None
    t = np.array([row['t'] for row in rings])
    weights = np.sqrt([row['count'] for row in rings])
    columns = []
    for _, positive, negative in limb.frame:
        wanted = np.array([(row['margins'][negative] - row['margins'][positive])/2 for row in rings])
        columns.append(np.polyfit(t, wanted, 1, w=weights) if len(rings) >= MIN_RINGS
                       else np.array([0., np.average(wanted, weights=weights)]))
    low, high = float(t.min()), float(t.max())

    def shift(values):
        clamped = np.clip(values, low, high)
        result = np.stack([np.polyval(column, clamped) for column in columns], axis=1)
        length = np.linalg.norm(result, axis=1, keepdims=True)
        return result*np.minimum(1., MAX_SHIFT_M/np.maximum(length, 1e-12))
    ends = shift(np.array([low, high]))
    if np.linalg.norm(ends, axis=1).max() < MIN_SHIFT_M:
        return None
    return shift, ends


def centre_limbs(objects, body, rig, slot, garment_kind=None):
    """Centre sleeves on the arms before weights are transferred.

    Trouser legs are only checked: short legs are rings around the pelvis, where equal
    clearances would pull the garment towards the other leg.
    """
    kinds = [kind for kind in _limbs(slot, garment_kind) if kind == 'arm']
    if not kinds:
        return {'method': 'ring_centring_v1', 'applied': False,
                'reason': 'legs_checked_only' if _limbs(slot, garment_kind) else 'no_limb_tubes'}
    joints = _joints(rig)
    body_points = _body_surface(body, rig)
    report = {'method': 'ring_centring_v1', 'applied': False, 'limbs': {}}
    for kind in kinds:
        for side in (1, -1):
            if (CHAINS[kind][0], side) not in joints or (CHAINS[kind][1], side) not in joints:
                continue
            limb = _Limb(kind, side, joints)
            model = _shift_model(limb, limb.rings(_garment_surface(objects), body_points))
            if model is None:
                report['limbs'][limb.name] = {'moved_vertices': 0}
                continue
            shift, ends = model
            moved = 0
            for obj, points in zip(objects, _points(objects)):
                t, inside = limb.region(points, REACH_M[kind][0])
                inside &= t > SEAM_M[kind]
                if not inside.any():
                    continue
                ramp = np.clip((t[inside] - SEAM_M[kind])/RAMP_M, 0, 1)
                weight = ramp*ramp*(3 - 2*ramp)
                offsets = shift(t[inside])
                delta = weight[:, None]*(offsets[:, :1]*limb.frame[0][0] + offsets[:, 1:]*limb.frame[1][0])
                inverse = np.linalg.inv(np.array(obj.matrix_world))[:3, :3]
                local = delta @ inverse.T
                co = np.empty(len(obj.data.vertices)*3); obj.data.vertices.foreach_get('co', co)
                co = co.reshape(-1, 3); co[inside] += local
                obj.data.vertices.foreach_set('co', co.reshape(-1))
                if obj.data.shape_keys:
                    for key in obj.data.shape_keys.key_blocks:
                        keyed = np.empty(len(key.data)*3); key.data.foreach_get('co', keyed)
                        keyed = keyed.reshape(-1, 3); keyed[inside] += local
                        key.data.foreach_set('co', keyed.reshape(-1))
                obj.data.update()
                moved += int(inside.sum())
            names = [limb.frame[0][1], limb.frame[1][1]]
            report['limbs'][limb.name] = {
                'moved_vertices': moved,
                'shift_cm': {'start': dict(zip(names, np.round(ends[0]*100, 1).tolist())),
                             'end': dict(zip(names, np.round(ends[1]*100, 1).tolist()))}}
            report['applied'] |= moved > 0
    return report


def _angle(limb, rings):
    """Angle between the garment tube and the limb, when the tube is long enough.

    Per ring the garment's cross-section box is off the body's by half the difference of
    opposite clearances (what centring removes); the slope of that offset is the tilt.
    """
    if len(rings) < MIN_RINGS or rings[-1]['t'] - rings[0]['t'] < .06:
        return None
    t = np.array([row['t'] for row in rings])
    slopes = [np.polyfit(t, [(row['margins'][positive] - row['margins'][negative])/2 for row in rings], 1)[0]
              for _, positive, negative in limb.frame]
    return float(np.degrees(np.arctan(np.hypot(*slopes))))


def check_limbs(objects, body, rig, slot, garment_kind=None):
    """Final pre-rig measurement: per limb the worst clearance, the opening's four clearances and the angle."""
    kinds = _limbs(slot, garment_kind)
    report = {'method': 'ring_margins_v1', 'status': 'pass', 'limbs': {}, 'failures': [],
              'thresholds': {'margin_cm': FAIL_MARGIN_M*100, 'angle_deg': FAIL_ANGLE_DEG}}
    if not kinds:
        report['status'] = 'not_applicable'
        return report
    joints = _joints(rig)
    body_points = _body_surface(body, rig)
    garment = _garment_surface(objects)
    for kind in kinds:
        for index, side in enumerate((1, -1)):
            if (CHAINS[kind][0], side) not in joints or (CHAINS[kind][1], side) not in joints:
                continue
            limb = _Limb(kind, side, joints)
            rings = limb.rings(garment, body_points)
            if not rings:
                report['limbs'][limb.name] = {'rings': 0}
                continue
            worst = min(((value, row['t'], direction) for row in rings
                         for direction, value in row['margins'].items()), key=lambda item: item[0])
            angle = _angle(limb, rings)
            report['limbs'][limb.name] = {
                'rings': len(rings), 'span_cm': round((rings[-1]['t'] - rings[0]['t'] + RING_M)*100, 1),
                'min_margin_cm': round(worst[0]*100, 1),
                'min_margin_at': {'t_cm': round(worst[1]*100, 1), 'direction': worst[2]},
                'opening_margins_cm': {key: round(value*100, 1) for key, value in rings[-1]['margins'].items()},
                'angle_deg': None if angle is None else round(angle, 1)}
            label = NAMES[kind][index]
            if worst[0] < FAIL_MARGIN_M:
                report['failures'].append({'limb': limb.name, 'reason': 'margin', 'direction': worst[2],
                                           'message': f'{label} {DIRECTIONS[worst[2]]}쪽 여유 {worst[0]*100:+.1f}cm'})
            if angle is not None and angle > FAIL_ANGLE_DEG:
                report['failures'].append({'limb': limb.name, 'reason': 'angle',
                                           'message': f'{label} 각도 {angle:.1f}°'})
    if report['failures']:
        report['status'] = 'fail'
    return report
