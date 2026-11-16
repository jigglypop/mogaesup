import { BufferAttribute, DataTexture, DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry, LinearFilter, Mesh, RedFormat, RepeatWrapping, Sphere, Vector3 } from 'three';
import { attribute, cos, dot, float, max, min, mix, modelWorldMatrix, normalize, sin, texture, transformNormalToView, vec2, vec3, vec4, vertexStage } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';

import type { BuiltSprigs } from './build';
import { fbm, hash, noise2, rng } from './noise';
import { WIND_ANGLE } from './ocean/waves';
import { wind } from './sprigs';

// The lawn as reeds grow: clumps of long blades that arch away from their root, standing taller where the ground is
// left wild, some with a reed's plume, all of them bent by one wind. The wind is the sea's (ocean/waves): a steady
// breeze leans every blade downwind, gusts run across the island in that direction (a moving pattern the clumps read
// where they stand, so a gust is seen as a wave going over the grass), and each blade flutters on its own. A blade is
// bent as an arc from its root, so it keeps its length however far it bends; its light turns with it, which is how a
// gust shows from above. Everything moves on the graphics card: the clumps are copies of two shapes, placed by the
// lawn's tufts (Builder's 'blade' sprigs), and the wind is worked out per corner in the vertex shader.

const TAU = Math.PI * 2;

/** Blades in a clump; segments up a blade, the last ending in its tip. */
const BLADES = 6;
const SEGMENTS = 4;
/** Where along a reed's stalk its rows of corners are: thin to the plume, then the plume's feathered head. */
const STALK_ROWS = [0, 0.34, 0.56, 0.64, 0.72, 0.8, 0.88, 0.94, 1];
/** A blade's half-width at its root, against the clump's spread, and how it narrows to the tip. */
const BLADE_HALF = 0.075;
/** The share of the lawn's tufts that become clumps: a clump is fuller than the tuft it stands for. */
const KEEP = 0.3;
/** A clump's spread and height against the tuft it stands for. */
const SPREAD = 1.5;
const TALL = 1.7;

/** The wind the sea is blown by, as the lawn lies: the way it blows and the way across it. */
const BLOW = vec2(Math.cos(WIND_ANGLE), Math.sin(WIND_ANGLE));
const ACROSS = vec2(-Math.sin(WIND_ANGLE), Math.cos(WIND_ANGLE));
/** The breeze's steady lean, in radians at a blade's tip; how much more a gust adds; a blade's own flutter. */
const BREEZE = 0.16;
const GUST = 0.42;
const FLUTTER = 0.07;
/** How fast a gust runs over the ground (metres a second), and how long and wide one is (metres). */
const GUST_SPEED = 2.6;
const GUST_LENGTH = 11;
const GUST_WIDTH = 19;
/** How fast a blade flutters (radians a second), and how far apart along the wind blades flutter together. */
const FLUTTER_RATE = 5.2;
const FLUTTER_SPAN = 0.8;
/** The steepest a blade bends at its tip, so that a reed in a gust stoops and does not fold over. */
const MOST_BEND = 1.25;
/** How much of a blade's light is the lawn's (straight up) rather than its own face's. */
const LAWN_LIGHT = 0.45;

/** A pattern of gusts that repeats every 64 texels: patches of moving air with calm between them. */
function gustMap(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = fbm((x + 0.5) / size, (y + 0.5) / size, 4, 3, 211);
      const strong = Math.min(1, Math.max(0, (value - 0.32) / 0.42));
      data[y * size + x] = Math.round(strong * strong * (3 - 2 * strong) * 255);
    }
  }
  const map = new DataTexture(data, size, size, RedFormat);
  map.wrapS = map.wrapT = RepeatWrapping;
  map.magFilter = map.minFilter = LinearFilter;
  map.generateMipmaps = false;
  map.needsUpdate = true;
  return map;
}

type Corners = { blade: number[]; shape: number[]; stem: number[]; positions: number[]; index: number[] };

/**
 * A blade's rows of corners: its root (`x`, `z` in the clump's measure), the way it faces and leans, its height, and at
 * each row how far up it is and how wide (signed for the side). `plume` marks the rows of a reed's head.
 */
function blade(into: Corners, x: number, z: number, facing: number, height: number, lean: number, phase: number, rows: readonly number[], width: (t: number) => number, plume: (t: number) => number, stem: number): void {
  const first = into.positions.length / 3;
  const push = (t: number, side: number) => {
    into.positions.push(x, t * height, z);
    into.blade.push(x, z, facing, height);
    into.shape.push(t, side * width(t), lean, phase);
    into.stem.push(stem, plume(t));
  };
  for (const t of rows.slice(0, -1)) {
    push(t, -1);
    push(t, 1);
  }
  push(rows[rows.length - 1]!, 0);
  const pairs = rows.length - 1;
  for (let row = 0; row < pairs - 1; row++) {
    const a = first + row * 2;
    into.index.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const last = first + (pairs - 1) * 2;
  into.index.push(last, last + 1, last + 2);
}

/** A clump: blades from roots about its middle, leaning out each its own way; `reed` adds a stalk with its plume. */
function clumpShape(reed: boolean): InstancedBufferGeometry {
  const random = rng(reed ? 41 : 37);
  const into: Corners = { blade: [], shape: [], stem: [], positions: [], index: [] };
  const rows = Array.from({ length: SEGMENTS + 1 }, (_, row) => row / SEGMENTS);
  for (let index = 0; index < BLADES; index++) {
    const turn = (index / BLADES) * TAU + random() * 0.9;
    const away = 0.05 + random() * 0.22;
    const half = BLADE_HALF * (0.8 + random() * 0.45);
    blade(
      into,
      Math.cos(turn) * away,
      Math.sin(turn) * away,
      turn + (random() - 0.5) * 0.7,
      0.55 + random() * 0.5,
      0.18 + random() * 0.5,
      random(),
      rows,
      (t) => half * (1 - t) ** 0.75,
      () => 0,
      0,
    );
  }
  if (reed) {
    const turn = random() * TAU;
    // The stalk is thin to its head; the head swells to a feathered plume and narrows to its tip.
    const width = (t: number) => (t < 0.58 ? 0.02 * (1 - t * 0.4) : 0.016 + 0.075 * Math.sin(Math.min(1, (t - 0.56) / 0.44) * Math.PI) ** 0.7);
    const plume = (t: number) => Math.min(1, Math.max(0, (t - 0.56) / 0.08));
    blade(into, Math.cos(turn) * 0.04, Math.sin(turn) * 0.04, turn, 1.5, 0.3 + random() * 0.15, random(), STALK_ROWS, width, plume, 1);
  }
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(into.index);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(into.positions), 3));
  geometry.setAttribute('aBlade', new BufferAttribute(new Float32Array(into.blade), 4));
  geometry.setAttribute('aShape', new BufferAttribute(new Float32Array(into.shape), 4));
  geometry.setAttribute('aStem', new BufferAttribute(new Float32Array(into.stem), 2));
  return geometry;
}

let shapes: { clump: InstancedBufferGeometry; reed: InstancedBufferGeometry } | null = null;
let shared: MeshStandardNodeMaterial | null = null;

/**
 * The material every clump is drawn with: the blades bent by the wind in the vertex shader, lit as the lawn they stand
 * in and as their own faces, darker at the root, warmer at the tip, a reed's plume the colour of dry straw.
 */
function grassMaterial(): MeshStandardNodeMaterial {
  if (shared) return shared;
  const gusts = gustMap();
  const root = attribute('aRoot', 'vec3');
  const size = attribute('aSize', 'vec3');
  const tint = attribute('aTint', 'vec3');
  const bladeOf = attribute('aBlade', 'vec4');
  const shape = attribute('aShape', 'vec4');
  const stem = attribute('aStem', 'vec2');
  const [spread, tall, yaw] = [size.x, size.y, size.z];
  const [t, width, lean, phase] = [shape.x, shape.y, shape.z, shape.w];

  // Where the blade's root is in the island, turned and spread with its clump.
  const turnCos = cos(yaw);
  const turnSin = sin(yaw);
  const local = vec2(bladeOf.x, bladeOf.y).mul(spread);
  const foot = vec3(root.x.add(local.x.mul(turnCos)).sub(local.y.mul(turnSin)), root.y, root.z.add(local.x.mul(turnSin)).add(local.y.mul(turnCos)));
  const facing = bladeOf.z.add(yaw);
  const out = vec2(cos(facing), sin(facing));
  const side = vec2(out.y.negate(), out.x);
  const height = bladeOf.w.mul(tall);

  // The wind where the blade stands in the village: the gusts move downwind over a pattern laid along the wind.
  const world = modelWorldMatrix.mul(vec4(foot, 1)).xz;
  const along = dot(world, BLOW);
  const across = dot(world, ACROSS);
  const gust = texture(gusts, vec2(along.sub(wind.mul(GUST_SPEED)).div(GUST_LENGTH), across.div(GUST_WIDTH))).level(float(0)).r;
  const flutter = sin(wind.mul(FLUTTER_RATE).add(phase.mul(TAU)).add(along.mul(FLUTTER_SPAN))).mul(FLUTTER).mul(float(0.6).add(gust));
  // The blade's own lean outward, the breeze and the gust downwind, the flutter across it: one bend, as an arc.
  const bend = out.mul(lean).add(BLOW.mul(gust.mul(GUST).add(BREEZE))).add(ACROSS.mul(flutter));
  const amount = min(max(bend.length(), 0.001), MOST_BEND);
  const toward = bend.normalize();
  const angle = amount.mul(t);
  const reach = height.mul(float(1).sub(cos(angle))).div(amount);
  const rise = height.mul(sin(angle)).div(amount);
  const half = width.mul(spread);
  const material = new MeshStandardNodeMaterial({ roughness: 0.78, metalness: 0, side: DoubleSide });
  material.positionNode = vec3(foot.x.add(toward.x.mul(reach)).add(side.x.mul(half)), foot.y.add(rise), foot.z.add(toward.y.mul(reach)).add(side.y.mul(half)));

  // The blade's face turns with its bend; the light it takes is part the lawn's, so the grass reads as one sward.
  const tangent = vec3(toward.x.mul(sin(angle)), cos(angle), toward.y.mul(sin(angle)));
  const face = vec3(side.x, 0, side.y).cross(tangent);
  const upward = face.y.lessThan(0).select(face.negate(), face);
  material.normalNode = normalize(vertexStage(transformNormalToView(normalize(mix(upward, vec3(0, 1, 0), LAWN_LIGHT)))));

  // Dark at the root, light and a little warm at the tip, each blade its own shade; a plume is pale straw.
  const shade = mix(float(0.56), float(1.12), t.pow(0.8)).mul(phase.sub(0.5).mul(0.2).add(1));
  const warm = mix(vec3(1), vec3(1.1, 1.03, 0.74), t.mul(t).mul(0.55));
  const blade = tint.mul(shade).mul(warm);
  const plume = mix(vec3(0.38, 0.32, 0.24), vec3(0.74, 0.67, 0.54), t.sub(0.56).div(0.44).clamp(0, 1));
  material.colorNode = vertexStage(mix(blade, plume, stem.y));
  shared = material;
  return material;
}

const point = new Vector3();
const axis = new Vector3();

/**
 * The lawn's tufts (`sprigs` of kind 'blade') as clumps of reed-like grass, one mesh: a share of the tufts stand as
 * clumps, sized from them, taller where the ground is left wild; some of the tall ones carry a plume.
 */
export function grassMeshes(sprigs: BuiltSprigs): Mesh[] {
  shapes ??= { clump: clumpShape(false), reed: clumpShape(true) };
  const kept: { root: [number, number, number]; size: [number, number, number]; tint: [number, number, number]; reed: boolean }[] = [];
  const { matrices, colors, count } = sprigs;
  for (let index = 0; index < count; index++) {
    const at = index * 16;
    const x = matrices[at + 12]!;
    const y = matrices[at + 13]!;
    const z = matrices[at + 14]!;
    // The same tufts stand as clumps on every visit: chosen by where they grow.
    const pick = hash(Math.floor(x * 97), Math.floor(z * 97), 7);
    if (pick > KEEP) continue;
    const wide = axis.set(matrices[at]!, matrices[at + 1]!, matrices[at + 2]!).length();
    const high = point.set(matrices[at + 4]!, matrices[at + 5]!, matrices[at + 6]!).length();
    const yaw = Math.atan2(-matrices[at + 2]!, matrices[at]!);
    // Wild patches grow tall: a slow swell over the ground, and the tallest of it in plume.
    const wild = Math.min(1, Math.max(0, (noise2(x / 6.5 + 31, z / 6.5 - 17, 5) - 0.42) / 0.3));
    const tall = high * TALL * (0.8 + wild * 0.75);
    const reed = wild > 0.6 && pick < KEEP * 0.16;
    kept.push({ root: [x, y, z], size: [wide * SPREAD * (1 + wild * 0.25), tall, yaw], tint: [colors[index * 3]!, colors[index * 3 + 1]!, colors[index * 3 + 2]!], reed });
  }
  const meshes: Mesh[] = [];
  for (const reed of [false, true]) {
    const chosen = kept.filter((item) => item.reed === reed);
    if (chosen.length === 0) continue;
    const base = reed ? shapes.reed : shapes.clump;
    const geometry = new InstancedBufferGeometry();
    // Its own copy of the clump's shape: a lawn let go takes its buffers with it, while the village's other lawns grow on.
    geometry.index = base.index && base.index.clone();
    for (const name of Object.keys(base.attributes)) geometry.setAttribute(name, base.getAttribute(name).clone());
    geometry.setAttribute('aRoot', new InstancedBufferAttribute(new Float32Array(chosen.flatMap((item) => item.root)), 3));
    geometry.setAttribute('aSize', new InstancedBufferAttribute(new Float32Array(chosen.flatMap((item) => item.size)), 3));
    geometry.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(chosen.flatMap((item) => item.tint)), 3));
    geometry.instanceCount = chosen.length;
    // What the clumps cover, for leaving out a lawn the camera does not see: their roots, and as high as a reed stands.
    let [minX, minZ, maxX, maxZ, top] = [Infinity, Infinity, -Infinity, -Infinity, 0];
    for (const { root, size } of chosen) {
      minX = Math.min(minX, root[0]);
      maxX = Math.max(maxX, root[0]);
      minZ = Math.min(minZ, root[2]);
      maxZ = Math.max(maxZ, root[2]);
      top = Math.max(top, root[1] + size[1] * 1.5);
    }
    const centre = new Vector3((minX + maxX) / 2, top / 2, (minZ + maxZ) / 2);
    geometry.boundingSphere = new Sphere(centre, Math.hypot(maxX - minX, maxZ - minZ, top) / 2 + 1);
    const mesh = new Mesh(geometry, grassMaterial());
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    meshes.push(mesh);
  }
  return meshes;
}
