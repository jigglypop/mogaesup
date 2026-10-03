"""Reproducible tile maps and texture derivatives: the numpy versions give the bytes of the per-texel loops they
replaced (kept below as the reference), and one owner computes only a few at a time."""
from array import array
import io
import math
import os
import random
from threading import Barrier, Event, Thread

from PIL import Image
import pytest

from src.services import studio_library, studio_materials
from src.services.character_pipeline import PipelineError


# --- the per-texel loops before numpy, unchanged ------------------------------------------------------------------

def reference_pattern_maps(surface, n, seed):
    """Return periodic height and colour modifiers for authored surface families."""
    rng = random.Random(seed)
    heights, colours = array('f'), array('f')
    tau = math.tau
    phase = rng.random()*tau
    if surface == 'wood':
        grain_count = rng.randint(8, 13)
        grain_s = [math.sin(tau*grain_count*x/n) for x in range(n)]
        grain_c = [math.cos(tau*grain_count*x/n) for x in range(n)]
        pore_s = [math.sin(tau*grain_count*3*x/n) for x in range(n)]
        pore_c = [math.cos(tau*grain_count*3*x/n) for x in range(n)]
        for y in range(n):
            v = y/n
            warp = .38*math.sin(tau*2*v+phase)+.14*math.sin(tau*5*v-phase*.7)
            warp_s, warp_c = math.sin(warp), math.cos(warp)
            pore_phase = tau*2*v+phase
            pore_phase_s, pore_phase_c = math.sin(pore_phase), math.cos(pore_phase)
            for x in range(n):
                grain = grain_s[x]*warp_c+grain_c[x]*warp_s
                pore = (pore_s[x]*pore_phase_c+pore_c[x]*pore_phase_s)*.18
                value = grain*.72+pore
                heights.append(value*.58)
                colours.append(value)
    elif surface == 'bark':
        ridge_count = rng.randint(7, 11)
        ridge_s = [math.sin(tau*ridge_count*x/n) for x in range(n)]
        ridge_c = [math.cos(tau*ridge_count*x/n) for x in range(n)]
        split_s = [math.sin(tau*ridge_count*2*x/n) for x in range(n)]
        split_c = [math.cos(tau*ridge_count*2*x/n) for x in range(n)]
        knot_s = [math.sin(tau*2*x/n) for x in range(n)]
        knot_c = [math.cos(tau*2*x/n) for x in range(n)]
        for y in range(n):
            v = y/n
            twist = .45*math.sin(tau*2*v+phase)+.2*math.sin(tau*5*v)
            twist_s, twist_c = math.sin(twist), math.cos(twist)
            split_phase = tau*3*v+phase
            split_phase_s, split_phase_c = math.sin(split_phase), math.cos(split_phase)
            knot_phase = phase-tau*3*v
            knot_phase_s, knot_phase_c = math.sin(knot_phase), math.cos(knot_phase)
            for x in range(n):
                ridge = ridge_s[x]*twist_c+ridge_c[x]*twist_s
                split = (split_s[x]*split_phase_c+split_c[x]*split_phase_s)*.28
                knots = (knot_s[x]*knot_phase_c+knot_c[x]*knot_phase_s)*.14
                value = ridge*.68+split+knots
                heights.append(value*.82)
                colours.append(value)
    else:
        rows, columns = 8, 6
        mortar = .075
        joint_s = [math.sin(math.pi*columns*x/n) for x in range(n)]
        joint_c = [math.cos(math.pi*columns*x/n) for x in range(n)]
        pit_s = [math.sin(tau*11*x/n) for x in range(n)]
        pit_c = [math.cos(tau*11*x/n) for x in range(n)]
        for y in range(n):
            v = y/n
            row_wave = abs(math.sin(math.pi*rows*v))
            row_phase = .5*(1-math.cos(tau*rows*v))
            joint_phase = math.pi*row_phase
            joint_phase_s, joint_phase_c = math.sin(joint_phase), math.cos(joint_phase)
            pit_phase = tau*7*v+phase
            pit_phase_s, pit_phase_c = math.sin(pit_phase), math.cos(pit_phase)
            for x in range(n):
                joint_wave = abs(joint_s[x]*joint_phase_c+joint_c[x]*joint_phase_s)
                joint_mask = min(1., row_wave/(mortar*math.pi))
                brick_face = min(1., row_wave/(mortar*math.pi), joint_wave/(mortar*math.pi))
                pitting = .08*(pit_s[x]*pit_phase_c+pit_c[x]*pit_phase_s)
                heights.append((brick_face-.5)*.7+pitting*joint_mask)
                colours.append((brick_face-.5)*.8+pitting)
    return heights, colours


def reference_tile_maps(surface, n, seed):
    """Lossless albedo, normal and ORM WebP bytes for one reproducible tile identity."""
    rng = random.Random(seed)
    # Preserve the original five surfaces byte-for-byte. New authored families
    # use their own periodic functions while sharing the same wrapped derivatives.
    if surface in {'wood', 'bark', 'brick'}:
        heights, colour_modifiers = reference_pattern_maps(surface, n, seed)
    else:
        # Integer frequencies produce a continuous periodic surface, including
        # normal derivatives. Each tile samples [0, 1), so texels aren't duplicated.
        waves = [(rng.randint(1, 24), rng.randint(-24, 24), rng.random()*math.tau,
                  .6**octave) for octave in range(7)]
        xs = [[math.sin(math.tau*fx*x/n+phase) for x in range(n)] for fx, _, phase, _ in waves]
        xc = [[math.cos(math.tau*fx*x/n+phase) for x in range(n)] for fx, _, phase, _ in waves]
        ys = [[math.sin(math.tau*fy*y/n) for y in range(n)] for _, fy, _, _ in waves]
        yc = [[math.cos(math.tau*fy*y/n) for y in range(n)] for _, fy, _, _ in waves]
        weight = sum(w[3] for w in waves)
        heights = array('f', (sum(a*(xs[i][x]*yc[i][y]+xc[i][x]*ys[i][y])
            for i, (_, _, _, a) in enumerate(waves))/weight for y in range(n) for x in range(n)))
        colour_modifiers = heights
    base = studio_library.SURFACES[surface]; albedo, normals, orm = bytearray(), bytearray(), bytearray()
    clamp = lambda v: max(0, min(255, round(v)))
    for y in range(n):
        for x in range(n):
            h = heights[y*n+x]
            colour = colour_modifiers[y*n+x]
            albedo.extend(clamp(c+(10 if surface == 'snow' else 24)*colour) for c in base)
            dx = (heights[y*n+(x+1)%n]-heights[y*n+(x-1)%n])*n*.025
            dy = (heights[((y+1)%n)*n+x]-heights[((y-1)%n)*n+x])*n*.025
            length = math.sqrt(dx*dx+dy*dy+1)
            normals.extend((clamp(127.5-dx/length*127.5), clamp(127.5+dy/length*127.5), clamp(127.5+127.5/length)))
            orm.extend((255, clamp(220+15*h), 0))
    maps = {}
    for name, raw in (('albedo', albedo), ('normal', normals), ('orm', orm)):
        output = io.BytesIO()
        Image.frombytes('RGB', (n, n), bytes(raw)).save(output, format='WEBP', lossless=True, method=4)
        maps[name+'.webp'] = output.getvalue()
    return maps


def reference_normals(rgb, size):
    height = rgb.convert('L').tobytes(); normals = bytearray()
    for y in range(size):
        for x in range(size):
            dx = (height[y*size+(x+1)%size]-height[y*size+(x-1)%size])*2/255
            dy = (height[((y+1)%size)*size+x]-height[((y-1)%size)*size+x])*2/255
            length = math.sqrt(dx*dx+dy*dy+1)
            normals.extend(round(127.5*(value/length+1)) for value in (-dx, dy, 1))
    return bytes(normals)


# --- tests ---------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize('surface', sorted(studio_library.SURFACES))
@pytest.mark.parametrize('n, seed', [(16, 0), (32, 2147483647), (48, 7)])
def test_tile_maps_keep_the_bytes_of_the_per_texel_loop(surface, n, seed):
    assert studio_library._tile_maps(surface, n, seed) == reference_tile_maps(surface, n, seed)


def test_texture_normals_keep_the_bytes_of_the_per_texel_loop(tmp_path):
    source = tmp_path / 'image.png'
    Image.frombytes('RGB', (40, 30), os.urandom(40*30*3)).save(source)
    files, _ = studio_materials.texture_maps(source, tmp_path, 32)
    with Image.open(io.BytesIO((tmp_path / 'albedo.webp').read_bytes())) as albedo:
        expected = reference_normals(albedo.convert('RGB'), 32)
    with Image.open(io.BytesIO((tmp_path / 'normal.webp').read_bytes())) as normal:
        assert normal.convert('RGB').tobytes() == expected
    assert set(files) == {'albedo.webp', 'normal.webp', 'orm.webp', 'manifest.json'}


def test_one_owner_computes_only_a_few_textures_at_a_time(monkeypatch):
    inside, release = Barrier(studio_library.TEXTURE_RUNS_PER_OWNER + 1), Event()
    results = []

    def hold(owner):
        with studio_library._texture_slot(owner):
            inside.wait(10)
            release.wait(10)

    threads = [Thread(target=hold, args=(1,)) for _ in range(studio_library.TEXTURE_RUNS_PER_OWNER)]
    for thread in threads:
        thread.start()
    inside.wait(10)
    try:
        with pytest.raises(PipelineError) as busy:
            with studio_library._texture_slot(1):
                pass
        assert busy.value.status == 429 and busy.value.code == 'texture_busy'
        # Another owner is not held up.
        with studio_library._texture_slot(2):
            results.append('other owner')
    finally:
        release.set()
        for thread in threads:
            thread.join(10)
    with studio_library._texture_slot(1):
        results.append('free again')
    assert results == ['other owner', 'free again'] and studio_library._texture_runs == {}
