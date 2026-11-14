import { BufferAttribute, BufferGeometry, DoubleSide, IcosahedronGeometry, MeshStandardMaterial, ShaderChunk, Vector3, type Material } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

import type { SprigKind } from './build';
import { noise3, rng } from './noise';
import { surfaceMaps } from './surfaces';

// The small shapes a garden is made of by the thousand: a spray of leaves, a tuft of grass, a flower, a stone. Each is
// one little shape drawn over and over (instanced), every copy with its own place, size and colour. Leaves and grass
// take their light as the crown or lawn they belong to would (so a tree shades as one soft mass, not as confetti), and
// stir in the wind.

/** The wind's clock, in seconds: every leaf reads it. Held still, nothing stirs. */
export const wind = { value: 0 };

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

/** A tuft of grass: blades leaning out from one root, dark at the foot and light at the tip. */
function grassTuft(): BufferGeometry {
  const random = rng(17);
  const into = sheet();
  for (let index = 0; index < 6; index++) {
    const turn = (index / 6) * Math.PI * 2 + random() * 0.7;
    const out = new Vector3(Math.cos(turn), 0, Math.sin(turn));
    const side = new Vector3(-out.z, 0, out.x).multiplyScalar(0.05);
    const height = 0.6 + random() * 0.4;
    const lean = 0.12 + random() * 0.3;
    const foot = out.clone().multiplyScalar(0.05 + random() * 0.08);
    const knee = foot.clone().addScaledVector(out, lean * 0.45).setY(height * 0.6);
    const tip = foot.clone().addScaledVector(out, lean).setY(height);
    const narrow = side.clone().multiplyScalar(0.55);
    // Two triangles a blade: the lower one up to its bend, the upper one from the bend to its tip.
    triangle(into, foot.clone().sub(side), foot.clone().add(side), knee, 0.66);
    triangle(into, knee.clone().sub(narrow).setY(height * 0.45), knee.clone().add(narrow).setY(height * 0.45), tip, 1.1);
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

const SHAPES: Record<SprigKind, () => BufferGeometry> = { leaf: leafSpray, needle: needleSpray, blade: grassTuft, bloom: blossom, frond, pad: lilyPad, puff, rock: () => stone(2), pebble: () => stone(1) };
/** How far the wind moves a copy's top, in its own size; how much it takes the light as its crown does (1) or as itself (0). */
const MANNER: Record<Exclude<SprigKind, 'rock' | 'pebble'>, { sway: number; soft: number; rough: number }> = {
  leaf: { sway: 0.05, soft: 0.72, rough: 0.72 },
  needle: { sway: 0.03, soft: 0.6, rough: 0.8 },
  blade: { sway: 0.1, soft: 0.9, rough: 0.85 },
  bloom: { sway: 0.05, soft: 0.6, rough: 0.7 },
  frond: { sway: 0.07, soft: 0.5, rough: 0.7 },
  pad: { sway: 0, soft: 0, rough: 0.35 },
  puff: { sway: 0.02, soft: 0.25, rough: 0.75 },
};

const geometries = new Map<SprigKind, BufferGeometry>();
const sprigMaterials = new Map<SprigKind, Material>();

export function sprigGeometry(kind: SprigKind): BufferGeometry {
  let geometry = geometries.get(kind);
  if (!geometry) {
    geometry = SHAPES[kind]();
    geometries.set(kind, geometry);
  }
  return geometry;
}

export function sprigMaterial(kind: SprigKind): Material {
  let material = sprigMaterials.get(kind);
  if (material) return material;
  if (kind === 'rock' || kind === 'pebble') {
    const maps = surfaceMaps('rock');
    material = new MeshStandardMaterial({ map: maps.map, normalMap: maps.normalMap, roughness: 0.92 });
  } else {
    const { sway, soft, rough } = MANNER[kind];
    const leafy = new MeshStandardMaterial({ roughness: rough, side: kind === 'puff' ? undefined : DoubleSide });
    leafy.onBeforeCompile = (shader) => {
      shader.uniforms['uWind'] = wind;
      shader.uniforms['uSway'] = { value: sway };
      shader.uniforms['uSoft'] = { value: soft };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aOut;\nattribute vec4 tint;\nuniform float uWind;\nuniform float uSway;\nuniform float uSoft;')
        .replace('#include <color_vertex>', '#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\nvColor.rgb = mix(vColor.rgb * tint.rgb, tint.rgb, tint.a);\n#endif')
        .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\ntransformedNormal = normalize(mix(transformedNormal, normalMatrix * aOut, uSoft));')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            float windPhase = instanceMatrix[3].x * 1.3 + instanceMatrix[3].z * 0.9;
            float windReach = max(position.y, 0.0) * uSway;
            transformed.x += sin(uWind * 1.9 + windPhase) * windReach;
            transformed.z += cos(uWind * 1.4 + windPhase * 1.3) * windReach;
          #endif`,
        );
      // A leaf seen from underneath is lit as its crown is, not as the leaf's own back.
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
    };
    leafy.customProgramCacheKey = () => `sprig|${kind === 'puff'}`;
    material = leafy;
  }
  sprigMaterials.set(kind, material);
  return material;
}
