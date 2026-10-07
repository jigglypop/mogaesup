"""The region weights of skirts and tops (avatar_garment_weights): plain numpy, no Blender."""
import numpy as np
import pytest

from src.services.avatar_garment_weights import (
    SKIRT_LEG_REACH, TOP_HOOD, TOP_LEFT, TOP_RIGHT, TOP_TORSO, gated_weights, region_mask, skirt_weights,
    top_bone_allowed, top_regions,
)

# Hips at z .5, knees at z .25, 10 cm apart; Blender frame (Z up, left at +X).
LEFT_HIP, RIGHT_HIP, LEFT_KNEE, RIGHT_KNEE = (.05, 0, .5), (-.05, 0, .5), (.05, 0, .25), (-.05, 0, .25)


def skirt(points):
    return skirt_weights(points, LEFT_HIP, RIGHT_HIP, LEFT_KNEE, RIGHT_KNEE)


def test_a_skirts_waistband_follows_the_pelvis_and_its_hem_the_thighs():
    weights = skirt([(0, -.05, .55), (.05, -.05, .5), (.05, -.05, .5 - SKIRT_LEG_REACH*.25), (-.08, -.05, .3)])
    np.testing.assert_allclose(weights.sum(axis=1), 1.)
    assert weights[0].tolist() == [1., 0., 0.] and weights[1].tolist() == [1., 0., 0.]
    # Wholly on the legs once SKIRT_LEG_REACH of the way down to the knees: the left one at the left hip's line.
    np.testing.assert_allclose(weights[2], [0., 1., 0.])
    np.testing.assert_allclose(weights[3], [0., 0., 1.])


def test_a_skirt_passes_from_one_leg_to_the_other_smoothly_between_the_hips():
    across = np.array([(x, -.05, .3) for x in np.linspace(-.05, .05, 21)])
    left = skirt(across)[:, 1]
    assert left[0] == 0. and left[-1] == 1. and left[10] == pytest.approx(.5)
    assert np.all(np.diff(left) >= 0) and np.abs(np.diff(left)).max() < .1
    # Down the front: no step anywhere on the way from the pelvis to the thighs.
    down = skirt([(.02, -.05, z) for z in np.linspace(.55, .3, 26)])
    assert np.abs(np.diff(down, axis=0)).max() < .15


def test_a_skeleton_without_measurable_hips_or_knees_is_refused():
    with pytest.raises(ValueError, match='hips and knees'):
        skirt_weights([(0, 0, .4)], (0, 0, .5), (0, 0, .5), LEFT_KNEE, RIGHT_KNEE)
    with pytest.raises(ValueError, match='hips and knees'):
        skirt_weights([(0, 0, .4)], LEFT_HIP, RIGHT_HIP, (.05, 0, .6), (-.05, 0, .6))


@pytest.mark.parametrize('region, key, allowed', [
    (TOP_TORSO, 'spine01', True), (TOP_TORSO, 'neck', True), (TOP_TORSO, 'head', False),
    (TOP_TORSO, 'leftarm', True),
    (TOP_LEFT, 'leftforearm', True), (TOP_LEFT, 'rightforearm', False), (TOP_LEFT, 'neck', False),
    (TOP_LEFT, 'head', False), (TOP_LEFT, 'spine02', True),
    (TOP_RIGHT, 'righthand', True), (TOP_RIGHT, 'leftshoulder', False),
    (TOP_HOOD, 'head', True), (TOP_HOOD, 'neck', True), (TOP_HOOD, 'leftshoulder', True),
    (TOP_HOOD, 'leftarm', False), (TOP_HOOD, 'rightforearm', False),
])
def test_each_region_of_a_top_follows_only_its_own_bones(region, key, allowed):
    assert top_bone_allowed(region, key) is allowed


def grid(xs, zs, y=0.):
    """A flat strip of quads over xs x zs: (points, edges)."""
    points = np.array([(x, y, z) for z in zs for x in xs], float)
    width = len(xs)
    edges = []
    for row in range(len(zs)):
        for col in range(width):
            index = row*width + col
            if col + 1 < width:
                edges.append((index, index + 1))
            if row + 1 < len(zs):
                edges.append((index, index + width))
    return points, np.array(edges)


ARMS = {'left': ((.1, 0, .6), (.5, 0, .6)), 'right': ((-.1, 0, .6), (-.5, 0, .6))}
HEAD = ((-.1, -.1, .62), (.1, .1, 1.))


def test_a_tops_sleeves_torso_and_hood_are_found_over_its_own_surface():
    # A T-shaped strip: arms out along X at z .6, the body below, a hood above the head's 60% line.
    sleeve_x = np.linspace(-.45, .45, 19)
    points, edges = grid(sleeve_x, [.58, .6, .62])
    body, body_edges = grid(np.linspace(-.1, .1, 5), np.linspace(.3, .56, 8))
    hood, hood_edges = grid(np.linspace(-.1, .1, 5), np.linspace(.64, .95, 8))
    # Stitch the body and the hood to the middle of the sleeve strip.
    offset_body, offset_hood = len(points), len(points) + len(body)
    stitch = [(offset_body + 7*5 + i, 7 + i) for i in range(5)] + [(offset_hood + i, 2*19 + 7 + i) for i in range(5)]
    points = np.concatenate([points, body, hood])
    edges = np.concatenate([edges, body_edges + offset_body, hood_edges + offset_hood, np.array(stitch)])
    regions = top_regions(points, edges, ARMS, HEAD)
    sleeve = regions[:3*19].reshape(3, 19)
    assert set(sleeve[:, 0]) == {TOP_RIGHT} and set(sleeve[:, -1]) == {TOP_LEFT}
    assert set(regions[offset_body:offset_body + 20]) == {TOP_TORSO}
    assert set(regions[offset_hood + 30:]) == {TOP_HOOD}
    # A UV seam: a duplicate of a sleeve end's vertex at the same position takes the same region.
    seam = np.concatenate([points, points[18:19]])
    assert top_regions(seam, edges, ARMS, HEAD)[-1] == TOP_LEFT


KEYS = ['spine02', 'leftarm', 'leftforearm', 'neck', 'head']


def chain(count):
    edges = np.array([(i, i + 1) for i in range(count - 1)])
    return edges


def test_a_sleeve_keeps_only_its_arms_and_the_torsos_weights():
    weights = np.array([[0, .7, 0, 0, .3], [0, .4, .4, .2, 0], [.5, .5, 0, 0, 0]], float)
    gated, changed = gated_weights(weights, KEYS, [TOP_LEFT, TOP_LEFT, TOP_LEFT], chain(3), smoothing=0)
    assert changed.tolist() == [True, True, False]
    np.testing.assert_allclose(gated.sum(axis=1), 1.)
    assert np.all(gated[:, KEYS.index('head')] == 0) and np.all(gated[:, KEYS.index('neck')] == 0)
    np.testing.assert_allclose(gated[1], [0, .5, .5, 0, 0])


def test_a_row_left_with_nothing_is_filled_from_its_neighbours_own_allowed_bones():
    # The sleeve's top followed the head; its neighbour along the sleeve follows the arm.
    weights = np.array([[0, 0, 0, 0, 1.], [0, 1., 0, 0, 0], [0, 0, 1., 0, 0]])
    gated, _ = gated_weights(weights, KEYS, [TOP_LEFT, TOP_LEFT, TOP_LEFT], chain(3), smoothing=0)
    np.testing.assert_allclose(gated[0], [0, 1., 0, 0, 0])


def test_a_piece_with_no_weighted_neighbour_follows_a_bone_its_region_allows():
    # Two loose sleeve vertices that followed only the head, in a top whose heaviest bone is the head (a hood).
    weights = np.array([[0, 0, 0, 0, 1.], [0, 0, 0, 0, 1.], [0, 0, 0, 0, 1.], [0, 0, 0, 0, 1.], [0, .3, .2, 0, 0]])
    regions = [TOP_LEFT, TOP_LEFT, TOP_HOOD, TOP_HOOD, TOP_LEFT]
    gated, _ = gated_weights(weights, KEYS, regions, np.array([(0, 1), (2, 3)]), smoothing=0)
    # Never the head (the top's heaviest bone): the arm, the heaviest the sleeve's region allows.
    np.testing.assert_allclose(gated[0], [0, 1., 0, 0, 0])
    np.testing.assert_allclose(gated[1], [0, 1., 0, 0, 0])
    np.testing.assert_allclose(gated[2:4], [[0, 0, 0, 0, 1.]]*2)


def test_smoothing_a_sleeve_beside_a_hood_never_brings_the_head_back():
    # A sleeve's top (gated off the head) between the hood and the arm.
    weights = np.array([[0, 0, 0, 0, 1.], [0, .5, 0, 0, .5], [0, 1., 0, 0, 0]])
    regions = [TOP_HOOD, TOP_LEFT, TOP_LEFT]
    gated, changed = gated_weights(weights, KEYS, regions, chain(3), smoothing=3)
    assert changed.tolist() == [False, True, False]
    assert gated[1, KEYS.index('head')] == 0 and gated[2, KEYS.index('head')] == 0
    np.testing.assert_allclose(gated.sum(axis=1), 1.)
    np.testing.assert_allclose(gated[0], [0, 0, 0, 0, 1.])


def test_gated_weights_keep_at_most_four_influences():
    keys = ['spine', 'spine01', 'spine02', 'leftarm', 'leftforearm', 'lefthand']
    weights = np.full((2, 6), 1/6)
    gated, _ = gated_weights(weights, keys, [TOP_LEFT, TOP_LEFT], chain(2), smoothing=1)
    assert ((gated > 0).sum(axis=1) <= 4).all()
    np.testing.assert_allclose(gated.sum(axis=1), 1.)


def test_region_mask_lets_an_unregioned_vertex_keep_every_bone():
    mask = region_mask(KEYS, [-1, TOP_LEFT])
    assert mask[0].tolist() == [1.]*5 and mask[1].tolist() == [1., 1., 1., 0., 0.]
