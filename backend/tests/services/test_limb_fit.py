"""Limb-fit measurement of a worn sleeve, on synthetic point clouds.

`avatar_limb_fit` imports `avatar_shell_garment`, which imports Blender modules at load time. The tests
install stand-ins for them, import the module fresh and take both modules out of `sys.modules` again.
"""
from __future__ import annotations

import importlib
import sys
import types

import numpy as np
import pytest

ROOT = np.array([.1, 0., 1.4])        # left shoulder (anatomical left is +X)
HAND = ROOT + np.array([.6, 0., 0.])
X, UP, FRONT = np.array([1., 0., 0.]), np.array([0., 0., 1.]), np.array([0., -1., 0.])
JOINTS = {('upperarm', 1): ROOT, ('hand', 1): HAND}
BODY_R, GARMENT_R = .035, .045
IMPORTED = ('src.services.avatar_limb_fit', 'src.services.avatar_shell_garment')


@pytest.fixture
def fit(monkeypatch):
    stubs = {name: types.ModuleType(name) for name in ('bpy', 'bmesh', 'mathutils', 'mathutils.bvhtree', 'mathutils.kdtree')}
    stubs['mathutils'].Vector = type('Vector', (), {})
    stubs['mathutils.bvhtree'].BVHTree = type('BVHTree', (), {})
    stubs['mathutils.kdtree'].KDTree = type('KDTree', (), {})
    for name, module in stubs.items():
        monkeypatch.setitem(sys.modules, name, module)
    services = importlib.import_module('src.services')
    for name in IMPORTED:   # put back (or removed) when the test ends, with the package attribute
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
        monkeypatch.setattr(services, name.rsplit('.', 1)[1], None, raising=False)
        del sys.modules[name]
    return importlib.import_module('src.services.avatar_limb_fit')


def tube(radius, stop, offset=None, axis=X, u=UP, v=FRONT, root=ROOT, sweep=2*np.pi, count=16, step=.002):
    """Points of a tube along `axis` from `root`; `offset(t)` gives its centre's (u, v) shift at each t."""
    t = np.arange(0., stop, step)
    shift = np.zeros((len(t), 2)) if offset is None else offset(t)
    theta = np.linspace(0, sweep, count, endpoint=sweep < 2*np.pi)
    ring = (shift[:, None, :1] + radius*np.cos(theta)[None, :, None])*u + (shift[:, None, 1:] + radius*np.sin(theta)[None, :, None])*v
    return (root + t[:, None, None]*axis + ring).reshape(-1, 3)


def constant(up):
    return lambda t: np.stack([np.full(len(t), up), np.zeros(len(t))], axis=1)


def rise(slope):
    return lambda t: np.stack([slope*t, np.zeros(len(t))], axis=1)


def faded(fit, up):
    """The residual of an `up` offset after centring: fully moved past the ramp, partly before it."""
    def offset(t):
        ramp = np.clip((t - fit.SEAM_M['arm'])/fit.RAMP_M, 0, 1)
        return np.stack([up*(1 - ramp*ramp*(3 - 2*ramp)), np.zeros(len(t))], axis=1)
    return offset


def measure(fit, monkeypatch, garment, body=None, joints=None):
    """check_limbs on point clouds (the Blender-side surface sampling is replaced)."""
    body = tube(BODY_R, .32) if body is None else body
    monkeypatch.setattr(fit, '_joints', lambda rig: JOINTS if joints is None else joints)
    monkeypatch.setattr(fit, '_body_surface', lambda *args: body)
    monkeypatch.setattr(fit, '_garment_surface', lambda objects: garment)
    return fit.check_limbs(None, None, None, 'top')


def slab(fit, limb, cloud, start):
    t = limb.local(cloud)[0]
    return cloud[(t >= start) & (t < start + fit.RING_M)]


def test_a_sleeve_hanging_off_the_arm_by_its_own_radius_is_measured_and_fails(fit, monkeypatch):
    garment, body = tube(GARMENT_R, .30, constant(GARMENT_R)), tube(BODY_R, .32)
    limb = fit._Limb('arm', 1, JOINTS)
    # The earlier closure test: does the garment go round the body's centre? Half a turn of it does not.
    g, b = slab(fit, limb, garment, .06), slab(fit, limb, body, .06)
    around = b.mean(axis=0)
    angle = np.arctan2((g - around) @ limb.frame[1][0], (g - around) @ limb.frame[0][0])
    assert len(np.unique(((angle + np.pi)/(2*np.pi)*fit.SECTORS).astype(int) % fit.SECTORS)) < fit.CLOSED_SECTORS

    rings = limb.rings(garment, body)
    assert len(rings) >= fit.MIN_RINGS
    for row in rings:
        assert row['margins'] == pytest.approx({'up': 2*GARMENT_R - BODY_R, 'down': -BODY_R,
                                                'front': GARMENT_R - BODY_R, 'back': GARMENT_R - BODY_R}, abs=1e-9)
    report = measure(fit, monkeypatch, garment, body)
    assert report['status'] == 'fail'
    assert report['limbs']['left_arm']['rings'] == len(rings)
    assert [(f['reason'], f['direction']) for f in report['failures']] == [('margin', 'down')]


def test_clearances_are_the_same_from_any_origin(fit):
    garment, body = tube(GARMENT_R, .30, constant(GARMENT_R)), tube(BODY_R, .32)
    limb = fit._Limb('arm', 1, JOINTS)
    ring = limb.rings(garment, body)[0]
    g, b = (slab(fit, limb, cloud, ring['t'] - fit.RING_M/2) for cloud in (garment, body))
    for origin in (b.mean(axis=0), g.mean(axis=0), np.array([3., -2., 5.])):
        for vector, positive, negative in limb.frame:
            reach_g, reach_b = (g - origin) @ vector, (b - origin) @ vector
            assert reach_g.max() - reach_b.max() == pytest.approx(ring['margins'][positive], abs=1e-9)
            assert reach_b.min() - reach_g.min() == pytest.approx(ring['margins'][negative], abs=1e-9)


def test_a_centred_sleeve_passes(fit, monkeypatch):
    report = measure(fit, monkeypatch, tube(GARMENT_R, .30))
    assert report['status'] == 'pass' and report['failures'] == []
    assert report['limbs']['left_arm']['min_margin_cm'] == pytest.approx(1., abs=.05)
    assert report['limbs']['left_arm']['angle_deg'] == pytest.approx(0., abs=.05)


def test_an_open_sleeve_is_still_not_a_ring(fit, monkeypatch):
    garment = tube(GARMENT_R, .30, sweep=np.radians(150), count=96)
    assert fit._Limb('arm', 1, JOINTS).rings(garment, tube(BODY_R, .32)) == []
    assert measure(fit, monkeypatch, garment)['status'] == 'unchecked'


@pytest.mark.parametrize('sweep, closed', [(150, False), (210, False), (330, True), (360, True)])
def test_closure_is_judged_around_the_rings_own_centre_for_any_turn_of_the_arc(fit, sweep, closed):
    """Clearly open arcs stay open at every orientation: the mean of an arc lies inside it and would pass 210 degrees half the time."""
    limb = fit._Limb('arm', 1, JOINTS)
    for turn in range(0, 360, 15):
        theta = np.radians(turn) + np.linspace(0, np.radians(sweep), 200, endpoint=sweep < 360)
        points = GARMENT_R*(np.cos(theta)[:, None]*limb.frame[0][0] + np.sin(theta)[:, None]*limb.frame[1][0]) + [.3, .2, .1]
        assert limb.closed(points) is closed


@pytest.mark.parametrize('case', ['no garment near the limb', 'sleeve out of reach', 'no joints'])
def test_no_measurable_ring_is_unchecked_not_pass(fit, monkeypatch, case):
    garment = {'no garment near the limb': lambda: tube(GARMENT_R, .30, root=ROOT + [0., 0., .5]),
               # farther off the arm than the garment's measuring reach, so only part of each ring is seen
               'sleeve out of reach': lambda: tube(GARMENT_R, .30, constant(.09)),
               'no joints': lambda: tube(GARMENT_R, .30)}[case]()
    report = measure(fit, monkeypatch, garment, joints={} if case == 'no joints' else None)
    assert report['status'] == 'unchecked' and report['failures'] == []
    assert all(limb == {'rings': 0} for limb in report['limbs'].values())


@pytest.mark.parametrize('failures, measured, status', [([], 0, 'unchecked'), ([], 1, 'pass'), ([], 2, 'pass'),
                                                       ([{'limb': 'left_arm'}], 0, 'fail'), ([{'limb': 'left_arm'}], 2, 'fail')])
def test_the_status_needs_a_measured_limb_to_pass(fit, failures, measured, status):
    assert fit._verdict(failures, measured) == status


def test_slots_without_limbs_stay_not_applicable(fit):
    assert fit.check_limbs(None, None, None, 'hair')['status'] == 'not_applicable'
    assert fit.check_limbs(None, None, None, 'bottom', 'skirt')['status'] == 'not_applicable'


def ramp_readings(fit, stop):
    """Rings of a centred sleeve that sat 2 cm off, and the tilt read from all of them (the earlier reading)."""
    rings = fit._Limb('arm', 1, JOINTS).rings(tube(GARMENT_R, stop, faded(fit, .02)), tube(BODY_R, .32))
    imbalance = [(row['margins']['up'] - row['margins']['down'])/2 for row in rings]
    assert imbalance[0] > .005 and abs(imbalance[-1]) < 1e-3   # the fade is in the measurement
    slope = np.polyfit([row['t'] for row in rings], imbalance, 1)[0]
    return rings, abs(np.degrees(np.arctan(slope)))


def test_the_centring_ramp_is_not_read_as_a_tilt_on_a_short_sleeve(fit, monkeypatch):
    """Within SEAM_M + RAMP_M of the shoulder a sleeve is corrected only in part, by design."""
    rings, all_rings = ramp_readings(fit, .15)
    assert all_rings > fit.FAIL_ANGLE_DEG   # a reviewer's case: this centred sleeve used to fail on its angle
    full = [row['t'] for row in rings if row['t'] >= fit.SEAM_M['arm'] + fit.RAMP_M]
    assert len(full) < fit.MIN_RINGS or full[-1] - full[0] < .06   # too short a corrected zone to measure a tilt
    assert fit._angle(fit._Limb('arm', 1, JOINTS), rings) is None
    report = measure(fit, monkeypatch, tube(GARMENT_R, .15, faded(fit, .02)))
    assert report['status'] == 'pass' and report['failures'] == []
    assert report['limbs']['left_arm']['angle_deg'] is None


def test_the_centring_ramp_is_not_read_as_a_tilt_on_a_long_sleeve(fit):
    rings, all_rings = ramp_readings(fit, .30)
    assert all_rings > .3   # the fade still leaks into a fit over every ring
    angle = fit._angle(fit._Limb('arm', 1, JOINTS), rings)
    assert angle is not None and angle < .01


def test_a_tilted_sleeve_still_fails_on_its_angle(fit, monkeypatch):
    garment = tube(.07, .20, rise(np.tan(np.radians(6))))   # drifts up 6 degrees from the arm, clearances stay positive
    report = measure(fit, monkeypatch, garment)
    assert report['limbs']['left_arm']['angle_deg'] == pytest.approx(6., abs=.2)
    assert report['limbs']['left_arm']['min_margin_cm'] > 0
    assert [f['reason'] for f in report['failures']] == ['angle']
    assert report['status'] == 'fail'


def frame_of_old_code(kind, axis):
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


def unit(*values):
    vector = np.array(values, dtype=float)
    return vector/np.linalg.norm(vector)


@pytest.mark.parametrize('kind, axis', [('arm', unit(1, 0, 0)), ('arm', unit(1, 0, -.4)), ('arm', unit(-.9, -.2, -.3)),
                                        ('arm', unit(.01, 0, 1)), ('leg', unit(0, 0, -1)), ('leg', unit(.1, -.05, -1)),
                                        ('leg', unit(-.1, .2, -1))])
def test_the_frame_of_an_ordinary_bone_is_unchanged(fit, kind, axis):
    for new, old in zip(fit._frame(kind, axis), frame_of_old_code(kind, axis)):
        assert new[1:] == old[1:]
        np.testing.assert_array_equal(new[0], old[0])


@pytest.mark.parametrize('kind, axis', [('arm', unit(0, 0, 1)), ('arm', unit(0, 0, -1)), ('arm', unit(1e-12, -1e-12, 1)),
                                        ('leg', unit(0, -1, 0)), ('leg', unit(0, 1, 0)), ('leg', unit(1e-12, 1, 1e-12))])
def test_a_bone_along_the_reference_direction_still_has_a_frame(fit, kind, axis):
    (first, *_), (second, *_) = fit._frame(kind, axis)
    assert np.isfinite(first).all() and np.isfinite(second).all()
    assert np.linalg.norm(first) == pytest.approx(1) and np.linalg.norm(second) == pytest.approx(1)
    assert abs(first @ axis) < 1e-9 and abs(second @ axis) < 1e-9 and abs(first @ second) < 1e-9


def test_a_vertical_arm_bone_is_measured(fit, monkeypatch):
    hand = ROOT - [0., 0., .6]
    joints = {('upperarm', 1): ROOT, ('hand', 1): hand}
    axis, u, v = np.array([0., 0., -1.]), FRONT, X
    report = measure(fit, monkeypatch, tube(GARMENT_R, .30, axis=axis, u=u, v=v),
                     tube(BODY_R, .32, axis=axis, u=u, v=v), joints)
    limb = report['limbs']['left_arm']
    assert report['status'] == 'pass' and limb['rings'] >= fit.MIN_RINGS
    assert limb['min_margin_cm'] == pytest.approx(1., abs=.05)


@pytest.mark.parametrize('end', [ROOT.copy(), np.full(3, np.nan)], ids=['zero length', 'not a number'])
def test_a_bone_without_a_direction_is_unchecked_and_not_nan(fit, monkeypatch, end):
    joints = {('upperarm', 1): ROOT, ('hand', 1): end}
    limb = fit._Limb('arm', 1, joints)
    assert limb.length == 0 and np.isfinite(limb.axis).all()
    assert all(np.isfinite(vector).all() for vector, *_ in limb.frame)
    assert limb.rings(tube(GARMENT_R, .30), tube(BODY_R, .32)) == []
    assert measure(fit, monkeypatch, tube(GARMENT_R, .30), joints=joints)['status'] == 'unchecked'
