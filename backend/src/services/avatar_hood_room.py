"""Room inside a raised hood for the hair worn under it.

A worn top's hood is registered to the bald wardrobe head and only pushed a few millimetres off
the scalp, so over the crown it lies where every hairstyle already is: hair shows through the
hood. The hood is lifted off the head as a whole. Each scalp point the hood lies over is given
the room it lacks (more over the crown, where hair stands highest), that lift is smoothed over the
scalp, and every hood vertex moves along the scalp normal beneath it by the lift there. Inner and
outer surfaces over one scalp point move together, so the hood keeps its thickness and shape;
below the collar nothing moves, so the neck and shoulders keep their fit.

Pure numpy: the assembly calls it with Blender's world geometry (Z up), tests with plain arrays.
"""
import numpy as np

ROOM_M = (.02, .04)      # room between scalp and hood at the ear line and at the crown
BLEND_M = .05            # above the collar the lift fades in over this height
REACH_M = .015           # hood surface this far sideways from a scalp point lies over it
ABOVE_M = (-.03, .2)     # hood surface along the scalp normal that counts as lying over it
NEAREST = 4              # scalp points a hood vertex takes its lift from
SMOOTH_ROUNDS = 10       # averaging rounds that spread the lift over the scalp
REACH_SCALP_M = .25      # a hood vertex farther than this from the scalp is not lifted
GATE_M = .04             # a vertex this much nearer the scalp than the rest of the body takes the whole lift


def _near_along(points, normals, cloud, up, reach=REACH_M, above=ABOVE_M):
    """Per point, the lowest cloud height along its normal within reach sideways, or nan."""
    lowest = np.full(len(points), np.nan)
    pad = reach + above[1]
    order = np.argsort(points[:, up], kind='stable')
    for start in range(0, len(order), 256):
        index = order[start:start+256]
        chunk, directions = points[index], normals[index]
        low, high = chunk.min(axis=0) - pad, chunk.max(axis=0) + pad
        near = cloud[np.all((cloud >= low) & (cloud <= high), axis=1)]
        if not len(near):
            continue
        offset = near[None, :, :] - chunk[:, None, :]
        along = np.einsum('cgk,ck->cg', offset, directions)
        sideways = np.linalg.norm(offset - along[:, :, None]*directions[:, None, :], axis=2)
        along = np.where((sideways < reach) & (along > above[0]) & (along < above[1]), along, np.inf)
        found = along.min(axis=1)
        lowest[index] = np.where(np.isfinite(found), found, np.nan)
    return lowest


def _nearest(points, targets, k, up, reach=REACH_SCALP_M):
    """Per point, the distances (inf where none) and indices of its k nearest targets within reach.
    Chunks follow height, and each chunk only meets the targets inside its padded box."""
    distance = np.full((len(points), k), np.inf)
    index = np.zeros((len(points), k), np.int64)
    order = np.argsort(points[:, up], kind='stable')
    for start in range(0, len(order), 512):
        rows = order[start:start+512]
        chunk = points[rows]
        low, high = chunk.min(axis=0) - reach, chunk.max(axis=0) + reach
        near = np.flatnonzero(np.all((targets >= low) & (targets <= high), axis=1))
        if not len(near):
            continue
        squared = ((chunk[:, None, :] - targets[near][None, :, :])**2).sum(axis=2)
        take = min(k, len(near))
        best = np.argpartition(squared, take - 1, axis=1)[:, :take]
        values = np.sqrt(np.take_along_axis(squared, best, axis=1))
        values[values > reach] = np.inf
        distance[rows, :take] = values
        index[rows, :take] = near[best]
    return distance, index


def _smooth(values, neighbours, rounds):
    """Spreads values over the scalp: one round of max (so a lift reaches the rim of the area that
    needs it), then averaging rounds over each vertex and its neighbours."""
    values = values.copy()
    rows = np.repeat(np.arange(len(neighbours)), [len(n) for n in neighbours])
    cols = np.concatenate([np.asarray(n, np.int64) for n in neighbours]) if len(rows) else np.zeros(0, np.int64)
    grown = values.copy()
    np.maximum.at(grown, rows, values[cols])
    values = grown
    counts = np.bincount(rows, minlength=len(values)) + 1.
    for _ in range(rounds):
        total = values.copy()
        np.add.at(total, rows, values[cols])
        values = total/counts
    return values


def hood_room(hood, scalp, normals, neighbours, rest, collar, up=2, room=ROOM_M, blend=BLEND_M):
    """Per hood vertex, the move (x, y, z) that lifts the hood off the scalp.

    hood: (n, 3) garment vertices above and below the collar; scalp: (m, 3) head vertices with unit
    normals; neighbours: per scalp vertex, the scalp vertices sharing a triangle with it; rest: (k, 3)
    the other body vertices (a sleeve nearer the shoulder than the scalp keeps its place); collar: the
    neck-head seam height; up: the vertical axis (2 in Blender, 1 in glTF). Returns (moves, report).
    """
    hood, scalp, normals, rest = (np.asarray(a, np.float64).reshape(-1, 3) for a in (hood, scalp, normals, rest))
    moves = np.zeros_like(hood)
    if not len(hood) or not len(scalp):
        return moves, {'lifted_vertices': 0, 'maximum_lift_m': 0.}
    inner = _near_along(scalp, normals, hood, up)
    top = scalp[:, up].max()
    crown = np.clip((scalp[:, up] - collar)/max(top - collar, 1e-6), 0., 1.)
    target = room[0] + (room[1] - room[0])*crown**2
    need = np.where(np.isnan(inner), 0., np.maximum(target - inner, 0.))
    lift = _smooth(need, neighbours, SMOOTH_ROUNDS)
    # Each hood vertex takes the lift and normal of the scalp points nearest it.
    distance, index = _nearest(hood, scalp, min(NEAREST, len(scalp)), up)
    found = np.isfinite(distance)
    weight = np.where(found, 1./np.maximum(distance, 1e-4), 0.)
    weight /= np.maximum(weight.sum(axis=1, keepdims=True), 1e-12)
    amount = (weight*lift[index]).sum(axis=1)
    direction = (weight[:, :, None]*normals[index]).sum(axis=1)
    direction /= np.maximum(np.linalg.norm(direction, axis=1, keepdims=True), 1e-9)
    height = np.clip((hood[:, up] - collar)/blend, 0., 1.)
    # Only the hood lifts: a vertex as near the shoulders or arms as the scalp keeps its place, over a
    # band GATE_M wide so the hood does not tear where it meets the shoulders.
    other = _nearest(hood, rest, 1, up)[0][:, 0] if len(rest) else np.full(len(hood), np.inf)
    gap = np.minimum(other, REACH_SCALP_M) - np.minimum(distance[:, 0], REACH_SCALP_M)
    gate = np.clip(gap/GATE_M + .5, 0., 1.)
    fade = height*height*(3 - 2*height)*gate*gate*(3 - 2*gate)
    moves = (fade*amount)[:, None]*direction
    lifted = np.linalg.norm(moves, axis=1)
    return moves, {'lifted_vertices': int((lifted > 1e-4).sum()), 'maximum_lift_m': round(float(lifted.max()), 4),
                   'scalp_under_hood': int((~np.isnan(inner)).sum())}
