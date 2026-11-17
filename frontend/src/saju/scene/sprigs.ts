import { BufferAttribute, BufferGeometry, DoubleSide, FrontSide, IcosahedronGeometry, Vector3, type Material } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, cos, mat4, max, mix, normalize, normalLocal, normalViewGeometry, positionGeometry, positionLocal, sin, texture, transformNormal, transformNormalToView, uniform, vec3, vec4 } from 'three/tsl';
import { MeshStandardNodeMaterial, type Node, type NodeBuilder } from 'three/webgpu';

import type { SprigKind } from './build';
import { noise3, rng } from './noise';
import { surfaceMaps } from './surfaces';

// The small shapes a garden is made of by the thousand: a spray of leaves, a tuft of grass, a flower, a stone. Each is
// one little shape drawn over and over (instanced), every copy with its own place, size and colour (see SprigMaterial). Leaves and grass
// take their light as the crown or lawn they belong to would (so a tree shades as one soft mass, not as confetti), and
// stir in the wind.

/** The wind's clock, in seconds: every leaf reads it. Held still, nothing stirs. */
export const wind = uniform(0);

type Sheet = { positions: number[]; normals: number[]; tints: number[] };

const sheet = (): Sheet => ({ positions: [], normals: [], tints: [] });

/** A flat triangle, seen from both sides; `shade` lightens or darkens it against its copy's colour. */
function triangle(into: Sheet, a: Vector3, b: Vector3, c: Vector3, shade: number | [number, number, number], replace = 0): void {
  const normal = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).normalize();
  for (const corner of [a, b, c]) {
    into.positions.push(corner.x, corner.y, corner.z);
    into.normals.push(normal.x, normal.y, normal.z);
    if (typeof shade === 'number') into.tints.push(shade, shade, shade, replace);
    else into.tints.push(shade[0], shade[1], shade[2], replace);
  }
}

function finished(from: Sheet): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(from.positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(from.normals), 3));
  geometry.setAttribute('tint', new BufferAttribute(new Float32Array(from.tints), 4));
  return geometry;
}

/** A leaf from `base` out along `along`, `length` long and `width` wide, creased down its middle. */
function leaf(into: Sheet, base: Vector3, along: Vector3, length: number, width: number, shade: number): void {
  const side = new Vector3(0, 1, 0).cross(along);
  if (side.lengthSq() < 0.01) side.set(1, 0, 0);
  side.normalize();
  const face = new Vector3().crossVectors(along, side);
  const mid = base.clone().addScaledVector(along, length * 0.45);
  const left = mid.clone().addScaledVector(side, -width / 2).addScaledVector(face, width * 0.22);
  const right = mid.clone().addScaledVector(side, width / 2).addScaledVector(face, width * 0.22);
  const tip = base.clone().addScaledVector(along, length);
  triangle(into, base, right, tip, shade);
  triangle(into, base, tip, left, shade * 0.93);
}

/** A spray of leaves about its stem's end, about one metre across (a copy is scaled down to a hand's width). */
function leafSpray(): BufferGeometry {
  const random = rng(11);
  const into = sheet();
  for (let index = 0; index < 7; index++) {
    const turn = (index / 7) * Math.PI * 2 + random() * 0.6;
    const lift = -0.15 + random() * 0.95;
    const along = new Vector3(Math.cos(turn), lift, Math.sin(turn)).normalize();
    const base = along.clone().multiplyScalar(random() * 0.16);
    leaf(into, base, along, 0.42 + random() * 0.2, 0.26 + random() * 0.1, 0.86 + random() * 0.28);
  }
  return finished(into);
}

/** A tuft of pine needles fanning from its twig. */
function needleSpray(): BufferGeometry {
  const random = rng(13);
  const into = sheet();
  for (let index = 0; index < 14; index++) {
    const turn = (index / 14) * Math.PI * 2 + random() * 0.4;
    const lift = 0.15 + random() * 0.85;
    const along = new Vector3(Math.cos(turn) * (1 - lift * 0.5), lift, Math.sin(turn) * (1 - lift * 0.5)).normalize();
    const side = new Vector3(-along.z, 0, along.x).normalize().multiplyScalar(0.035);
    const base = new Vector3();
    const tip = along.clone().multiplyScalar(0.5 + random() * 0.14);
    const shade = 0.8 + random() * 0.4;
    triangle(into, base.clone().sub(side), base.clone().add(side), tip, shade);
  }
  return finished(into);
}

/** A flower seen from above: petals about a yellow heart, cupped a little. */
function blossom(): BufferGeometry {
  const into = sheet();
  const heart: [number, number, number] = [1, 0.8, 0.24];
  const centre = new Vector3(0, 0.02, 0);
  for (let index = 0; index < 6; index++) {
    const turn = (index / 6) * Math.PI * 2;
    const out = new Vector3(Math.cos(turn), 0.22, Math.sin(turn));
    const side = new Vector3(-Math.sin(turn), 0, Math.cos(turn));
    const mid = out.clone().multiplyScalar(0.3);
    const tip = out.clone().multiplyScalar(0.52);
    const left = mid.clone().addScaledVector(side, -0.2);
    const right = mid.clone().addScaledVector(side, 0.2);
    triangle(into, centre, right, tip, index % 2 ? 1 : 0.9);
    triangle(into, centre, tip, left, index % 2 ? 0.94 : 0.86);
    const next = ((index + 1) / 6) * Math.PI * 2;
    triangle(into, new Vector3(0, 0.07, 0), new Vector3(Math.cos(next) * 0.13, 0.06, Math.sin(next) * 0.13), new Vector3(Math.cos(turn) * 0.13, 0.06, Math.sin(turn) * 0.13), heart, 1);
  }
  return finished(into);
}

/** One long blade arching over: a reed, an iris leaf, a bamboo leaf, a willow's strand. */
function frond(): BufferGeometry {
  const into = sheet();
  const steps = 5;
  const at = (step: number) => {
    const t = step / steps;
    return { middle: new Vector3(0, t * (1 - t * 0.28), t * t * 0.42), half: 0.07 * (1 - t) + 0.008 };
  };
  for (let step = 0; step < steps; step++) {
    const a = at(step);
    const b = at(step + 1);
    const shade = 0.72 + (step / steps) * 0.42;
    const a0 = a.middle.clone().setX(-a.half);
    const a1 = a.middle.clone().setX(a.half);
    const b0 = b.middle.clone().setX(-b.half);
    const b1 = b.middle.clone().setX(b.half);
    triangle(into, a0, a1, b1, shade);
    triangle(into, a0, b1, b0, shade);
  }
  return finished(into);
}

/** A lily pad: a round leaf lying flat, a notch cut to its middle. */
function lilyPad(): BufferGeometry {
  const into = sheet();
  const centre = new Vector3(0, 0, 0);
  const sides = 14;
  for (let index = 1; index < sides - 1; index++) {
    const a = (index / sides) * Math.PI * 2;
    const b = ((index + 1) / sides) * Math.PI * 2;
    triangle(into, centre, new Vector3(Math.cos(b) * 0.5, 0, Math.sin(b) * 0.5), new Vector3(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5), index % 2 ? 1 : 0.92);
  }
  return finished(into);
}

/** A soft round ball: a hydrangea's head, a berry, a bud. */
function puff(): BufferGeometry {
  const geometry = new IcosahedronGeometry(0.5, 1);
  const count = geometry.getAttribute('position').count;
  const tints = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) {
    const shade = 0.82 + (geometry.getAttribute('position').getY(index) + 0.5) * 0.3;
    tints.set([shade, shade, shade, 0], index * 4);
  }
  geometry.setAttribute('tint', new BufferAttribute(tints, 4));
  geometry.deleteAttribute('uv');
  return geometry;
}

/** A stone: a ball pushed out of round, a little flat underneath; `detail` is how finely it is cut. */
function stone(detail: number): BufferGeometry {
  const geometry = mergeVertices(new IcosahedronGeometry(0.5, detail).deleteAttribute('normal').deleteAttribute('uv'));
  const position = geometry.getAttribute('position');
  const point = new Vector3();
  const uvs = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index++) {
    point.fromBufferAttribute(position, index);
    const lump = 0.72 + noise3(point.x * 2.6 + 9, point.y * 2.6, point.z * 2.6, 5) * 0.4 + noise3(point.x * 7, point.y * 7, point.z * 7, 6) * 0.12;
    point.multiplyScalar(lump);
    if (point.y < -0.22) point.y = -0.22 - (point.y + 0.22) * 0.2;
    position.setXYZ(index, point.x, point.y, point.z);
    // Textured from above, sheared a little so its sides are not smeared.
    uvs[index * 2] = point.x * 0.9 + point.y * 0.4;
    uvs[index * 2 + 1] = point.z * 0.9 + point.y * 0.4;
  }
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

const SHAPES: Record<SprigKind, () => BufferGeometry> = { leaf: leafSpray, needle: needleSpray, bloom: blossom, frond, pad: lilyPad, puff, rock: () => stone(2), pebble: () => stone(1) };
/**
 * How far the wind moves the top of a copy of each, in metres at the size it is scattered at; how much it takes the light
 * as its crown does (1) or as itself (0).
 */
const MANNER: Record<Exclude<SprigKind, 'rock' | 'pebble'>, { sway: number; soft: number; rough: number }> = {
  leaf: { sway: 0.016, soft: 0.72, rough: 0.72 },
  needle: { sway: 0.012, soft: 0.6, rough: 0.8 },
  bloom: { sway: 0.006, soft: 0.6, rough: 0.7 },
  frond: { sway: 0.032, soft: 0.5, rough: 0.7 },
  pad: { sway: 0, soft: 0, rough: 0.35 },
  puff: { sway: 0.004, soft: 0.25, rough: 0.75 },
};

const geometries = new Map<SprigKind, BufferGeometry>();
const sprigMaterials = new Map<SprigKind, Material>();

export function sprigGeometry(kind: SprigKind): BufferGeometry {
  let geometry = geometries.get(kind);
  if (!geometry) {
    geometry = SHAPES[kind]();
    // A leafy kind's way with the wind and the light, on each corner of its shape (see LEAFY).
    if (kind !== 'rock' && kind !== 'pebble') {
      const { sway, soft } = MANNER[kind];
      const count = geometry.getAttribute('position').count;
      const manner = new Float32Array(count * 2);
      for (let index = 0; index < count; index++) manner.set([sway, soft], index * 2);
      geometry.setAttribute('manner', new BufferAttribute(manner, 2));
    }
    geometries.set(kind, geometry);
  }
  return geometry;
}

/**
 * A copy's matrix, which a scattering carries beside its shape as four columns (`aM0`..`aM3`, see Built), its colour
 * (`aColor`) and the way out from the crown or lawn it belongs to (`aOut`), each copy's read from its own vertex buffer.
 */
const placing = mat4(attribute('aM0', 'vec4'), attribute('aM1', 'vec4'), attribute('aM2', 'vec4'), attribute('aM3', 'vec4'));
const copyColor = attribute('aColor', 'vec3');

/**
 * A scattering's material: each copy of the shape moved, turned and sized by its own matrix, and its normals turned with
 * it, where and as three places an instanced mesh's copies (before the material's own `positionNode`). Three builds an
 * instanced mesh's program again for every such mesh, since it binds the mesh's own matrices into it; these are read
 * from the geometry by name, so every scattering of a kind on every island is one program, built once. The shadow's
 * pass draws with a material of its own, which takes `castShadowPositionNode`: there the copy is placed as well.
 */
class SprigMaterial extends MeshStandardNodeMaterial {
  static override get type(): string {
    return 'SprigMaterial';
  }

  override setupPosition(builder: NodeBuilder): Node {
    positionLocal.assign(placing.mul(vec4(positionLocal, 1)).xyz);
    normalLocal.assign(transformNormal(normalLocal, placing));
    return super.setupPosition(builder);
  }
}

/** A copy's corner where the copy stands (the shadow's pass places it itself, see SprigMaterial). */
const placed = placing.mul(vec4(positionGeometry, 1)).xyz;
/** A leafy kind's way with the wind (x, metres at its top) and with the light (y), from its shape's corners (see MANNER). */
const manner = attribute('manner', 'vec2');

/** Where the wind takes `at`, a corner of a copy in its place: more the higher up the shape, copies near one another together. */
function swayed(at: Node<'vec3'>): Node<'vec3'> {
  const phase = at.x.mul(1.3).add(at.z.mul(0.9));
  const reach = max(positionGeometry.y, 0).mul(manner.x);
  return at.add(vec3(sin(wind.mul(1.9).add(phase)).mul(reach), 0, cos(wind.mul(1.4).add(phase.mul(1.3))).mul(reach)));
}

/**
 * What every leafy kind is drawn with, the same nodes for each: three tells programs apart by their nodes, so the
 * kinds share one program (two, a puff's being one-sided) and what sets them apart rides on their shapes' corners.
 */
const tint = attribute('tint', 'vec4');
const LEAFY = {
  // Each corner of the little shape shades its copy's colour (darker at a blade's foot, a leaf's crease); a part that
  // keeps a colour of its own (a flower's yellow heart) keeps it.
  color: mix(tint.rgb.mul(copyColor), tint.rgb, tint.a),
  // The copy stands in its place already (see SprigMaterial): the wind moves its top.
  position: swayed(positionLocal),
  shadow: swayed(placed),
  // Lit as the crown or the lawn it belongs to would be, and from underneath as from above: not as the leaf's own back.
  normal: normalize(mix(normalViewGeometry, transformNormalToView(attribute('aOut', 'vec3')), manner.y)),
};
/** A stone's colour, the same node for rocks and pebbles (see LEAFY): made with the first. */
let stoneColor: Node<'vec3'> | null = null;

export function sprigMaterial(kind: SprigKind): Material {
  let material = sprigMaterials.get(kind);
  if (material) return material;
  if (kind === 'rock' || kind === 'pebble') {
    const maps = surfaceMaps('rock');
    const stone = new SprigMaterial({ normalMap: maps.normalMap, roughness: 0.92 });
    stone.colorNode = stoneColor ??= texture(maps.map).rgb.mul(copyColor);
    stone.castShadowPositionNode = placed;
    material = stone;
  } else {
    const leafy = new SprigMaterial({ roughness: MANNER[kind].rough, side: kind === 'puff' ? FrontSide : DoubleSide });
    leafy.colorNode = LEAFY.color;
    leafy.positionNode = LEAFY.position;
    leafy.castShadowPositionNode = LEAFY.shadow;
    leafy.normalNode = LEAFY.normal;
    material = leafy;
  }
  sprigMaterials.set(kind, material);
  return material;
}
