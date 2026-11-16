import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Matrix3,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three';

import { rng } from './noise';
import { surfaceMaps, type Surface } from './surfaces';

// A home is tens of thousands of small shapes: every roof tile, baluster, stone and leaf. They are not mounted one by
// one; a Builder is handed them in plain calls and piles them up by what they are made of, so a whole home ends as a
// dozen meshes and a few instanced ones. What moves on its own (smoke, a flame, the guardian) is mounted beside it.

export type V3 = [number, number, number];

export type Finish = {
  /** What it is made of, close up (see surfaces). */
  surface?: Surface;
  /** 0 mirror … 1 chalk. */
  rough?: number;
  metal?: number;
  /** Lit from inside in this colour, `power` strong (1 is as bright as a sunlit white wall). */
  glow?: string;
  power?: number;
  /** Below 1 it is see-through. */
  opacity?: number;
  /** Seen from behind too. */
  twoSided?: boolean;
  /** Each shape's colour a little lighter or darker than asked, by up to this share: no two tiles alike. */
  vary?: number;
  /** Throws no shadow. */
  shadowless?: boolean;
};

/** What is scattered by the thousand, drawn as copies of one small shape (see flora). */
export type SprigKind = 'leaf' | 'needle' | 'blade' | 'bloom' | 'frond' | 'pad' | 'puff' | 'rock' | 'pebble';

/** A light that shines on what is near it: a lantern, a window, a fire. */
export type Lamp = { at: V3; color: string; power: number; reach: number; flicker?: boolean };

/** Something that moves on its own, mounted beside the built home. */
export type Life =
  | { kind: 'smoke'; at: V3; scale?: number }
  | { kind: 'fire'; at: V3; scale?: number }
  | { kind: 'fireflies'; at: V3; reach: number; count: number }
  | { kind: 'petals'; at: V3; reach: number; color: string }
  | { kind: 'mist'; at: V3; reach: number }
  | { kind: 'koi'; at: V3; reach: number; color: string; phase: number }
  | { kind: 'butterfly'; at: V3; color: string; phase: number }
  | { kind: 'ripples'; at: V3; reach: number }
  | { kind: 'beam'; at: V3 };

/** The lit glass of a window, by what is behind it. */
export type PaneStyle = 'room' | 'paper' | 'lantern';

type Template = { positions: ArrayLike<number>; normals: ArrayLike<number>; uvs: ArrayLike<number>; indices: ArrayLike<number>; wrap: boolean };
type Pile = { material: Material; look: Finishing; cast: boolean; tile: number; grain: boolean; positions: number[]; normals: number[]; uvs: number[]; colors: number[]; indices: number[] };
type Sprigs = { matrices: number[]; colors: number[]; outs: number[] };

/**
 * What a mesh's material is made from, as plain data: a finish (see materialOf) or a pane of lit glass (paneMaterial).
 * A build kept between visits (see shelf) is kept with these, and its materials found again from them.
 */
export type Finishing = { finish: Required<Pick<Finish, 'surface' | 'rough' | 'metal' | 'power' | 'opacity' | 'twoSided'>> & { glow: string | null } } | { pane: PaneStyle; power: number };
/** A mesh of a build: `look` is what its material is made from (a build that has none for a mesh is not kept between visits). */
export type BuiltMesh = { geometry: BufferGeometry; material: Material; cast: boolean; look?: Finishing };
export type BuiltSprigs = { kind: SprigKind; count: number; matrices: Float32Array; colors: Float32Array; outs: Float32Array };
export type Build = { meshes: BuiltMesh[]; sprigs: BuiltSprigs[]; lamps: Lamp[]; lives: Life[] };

const templates = new Map<string, Template>();

function templateOf(key: string, make: () => BufferGeometry, wrap: boolean): Template {
  let template = templates.get(key);
  if (!template) {
    const geometry = make();
    const indexed = geometry.index ? geometry : geometry.clone();
    if (!indexed.index) indexed.setIndex(Array.from({ length: indexed.getAttribute('position').count }, (_, index) => index));
    if (!indexed.getAttribute('normal')) indexed.computeVertexNormals();
    const count = indexed.getAttribute('position').count;
    template = {
      positions: indexed.getAttribute('position').array,
      normals: indexed.getAttribute('normal').array,
      uvs: indexed.getAttribute('uv')?.array ?? new Float32Array(count * 2),
      indices: indexed.index!.array,
      wrap,
    };
    templates.set(key, template);
  }
  return template;
}

const BOX = () => templateOf('box', () => new BoxGeometry(1, 1, 1), false);
const PLANE = () => templateOf('plane', () => new PlaneGeometry(1, 1), false);

/** A gable's prism one unit wide (x), deep (z) and high, its ridge along x: `ridge` 1 a gable, less a hip, 0 a pyramid. */
function prismGeometry(ridge: number): BufferGeometry {
  const r = ridge / 2;
  const a = [-0.5, 0, 0.5];
  const b = [0.5, 0, 0.5];
  const c = [0.5, 0, -0.5];
  const d = [-0.5, 0, -0.5];
  const l = [-r, 1, 0];
  const h = [r, 1, 0];
  const faces = [[a, b, h], [a, h, l], [c, d, l], [c, l, h], [b, c, h], [d, a, l], [a, d, c], [a, c, b]];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(faces.flat(2)), 3));
  geometry.computeVertexNormals();
  return geometry;
}

const colors = new Map<string, Color>();
function colorOf(hex: string): Color {
  let color = colors.get(hex);
  if (!color) {
    color = new Color(hex);
    colors.set(hex, color);
  }
  return color;
}

const materials = new Map<string, MeshStandardMaterial>();
/** Materials that glow, and how strongly by day's last light: the hour turns them all up or down together. */
const glowing = new Map<MeshStandardMaterial, number>();
let lampGain = 1;

/** Turns every lit thing up or down: `gain` 1 at sunset, more after dark. */
export function setLampGain(gain: number): void {
  lampGain = gain;
  for (const [material, power] of glowing) material.emissiveIntensity = power * gain;
}

function materialOf(finish: Finish): { material: MeshStandardMaterial; key: string; look: Finishing } {
  const { surface = 'plain', rough = 0.85, metal = 0, glow, power = 1, opacity = 1, twoSided = false } = finish;
  const key = `${surface}|${rough}|${metal}|${glow ?? ''}|${power}|${opacity}|${twoSided}`;
  const look: Finishing = { finish: { surface, rough, metal, glow: glow ?? null, power, opacity, twoSided } };
  let material = materials.get(key);
  if (!material) {
    material = new MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: metal });
    if (surface !== 'plain') {
      const maps = surfaceMaps(surface);
      material.map = maps.map;
      material.normalMap = maps.normalMap;
    }
    if (glow) {
      material.emissive.set(glow);
      material.emissiveIntensity = power * lampGain;
      glowing.set(material, power);
    }
    if (opacity < 1) {
      material.transparent = true;
      material.opacity = opacity;
      material.depthWrite = false;
    }
    if (twoSided) material.side = DoubleSide;
    materials.set(key, material);
  }
  return { material, key, look };
}

/** The material a kept mesh's `look` calls for: the same one its build was made with. */
export function materialFor(look: Finishing): Material {
  if ('pane' in look) return paneMaterial(look.pane, look.power);
  const { glow, ...finish } = look.finish;
  return materialOf(glow === null ? finish : { ...finish, glow }).material;
}

const panes = new Map<string, MeshStandardMaterial>();

/** A window at night from outside: the room's light, warmer low down, curtains at the sides. */
function paneTexture(style: PaneStyle): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    if (style === 'paper') {
      // 창호지: paper lit from behind, the lattice in front of it.
      const light = context.createRadialGradient(size / 2, size * 0.55, 6, size / 2, size / 2, size * 0.8);
      light.addColorStop(0, '#fff3cf');
      light.addColorStop(1, '#f1c98a');
      context.fillStyle = light;
      context.fillRect(0, 0, size, size);
      context.strokeStyle = '#4a3324';
      context.lineWidth = 4;
      for (let line = 0; line <= 4; line++) {
        context.beginPath();
        context.moveTo((line * size) / 4, 0);
        context.lineTo((line * size) / 4, size);
        context.stroke();
      }
      context.lineWidth = 3;
      for (const y of [0.2, 0.34, 0.66, 0.8]) {
        context.beginPath();
        context.moveTo(0, y * size);
        context.lineTo(size, y * size);
        context.stroke();
      }
    } else if (style === 'lantern') {
      const light = context.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size * 0.7);
      light.addColorStop(0, '#fffbe6');
      light.addColorStop(0.5, '#ffd98f');
      light.addColorStop(1, '#f2a95a');
      context.fillStyle = light;
      context.fillRect(0, 0, size, size);
    } else {
      const light = context.createLinearGradient(0, 0, 0, size);
      light.addColorStop(0, '#f6b866');
      light.addColorStop(0.55, '#ffd995');
      light.addColorStop(1, '#ffe9b8');
      context.fillStyle = light;
      context.fillRect(0, 0, size, size);
      const lamp = context.createRadialGradient(size * 0.62, size * 0.5, 2, size * 0.62, size * 0.5, size * 0.5);
      lamp.addColorStop(0, 'rgba(255,252,235,0.95)');
      lamp.addColorStop(1, 'rgba(255,240,200,0)');
      context.fillStyle = lamp;
      context.fillRect(0, 0, size, size);
      // Curtains drawn back to either side, and the shelf of a room behind.
      for (const [from, to] of [[0, 0.2], [1, 0.8]] as const) {
        const fold = context.createLinearGradient(from * size, 0, to * size, 0);
        fold.addColorStop(0, 'rgba(150,84,52,0.9)');
        fold.addColorStop(0.6, 'rgba(196,128,84,0.75)');
        fold.addColorStop(1, 'rgba(210,150,100,0)');
        context.fillStyle = fold;
        context.fillRect(Math.min(from, to) * size, 0, 0.2 * size, size);
      }
      context.fillStyle = 'rgba(120,70,40,0.5)';
      context.fillRect(size * 0.28, size * 0.3, size * 0.2, size * 0.04);
      context.fillRect(size * 0.28, size * 0.52, size * 0.2, size * 0.04);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function paneMaterial(style: PaneStyle, power: number): MeshStandardMaterial {
  const key = `${style}|${power}`;
  let material = panes.get(key);
  if (!material) {
    const texture = paneTexture(style);
    material = new MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: '#ffffff', emissiveIntensity: power * lampGain, roughness: 0.25, vertexColors: true });
    glowing.set(material, power);
    panes.set(key, material);
  }
  return material;
}

const UP = new Vector3(0, 1, 0);

/** The attributes a Builder's pile carries; a mesh with these alone can be joined to another of its material. */
const PILE_ATTRIBUTES = ['position', 'normal', 'uv', 'color'] as const;
const joinable = (geometry: BufferGeometry) =>
  geometry.index !== null && Object.keys(geometry.attributes).length === PILE_ATTRIBUTES.length && PILE_ATTRIBUTES.every((name) => geometry.getAttribute(name)?.itemSize === { position: 3, normal: 3, uv: 2, color: 3 }[name]);

/** `geometries` (Builder piles of one material), each moved by its `at`, as one. */
function joined(items: readonly { geometry: BufferGeometry; at: V3 }[]): BufferGeometry {
  const vertices = items.reduce((sum, { geometry }) => sum + geometry.getAttribute('position').count, 0);
  const corners = items.reduce((sum, { geometry }) => sum + geometry.index!.count, 0);
  const arrays = { position: new Float32Array(vertices * 3), normal: new Float32Array(vertices * 3), uv: new Float32Array(vertices * 2), color: new Float32Array(vertices * 3) };
  const index = vertices > 65535 ? new Uint32Array(corners) : new Uint16Array(corners);
  let vertex = 0;
  let corner = 0;
  for (const { geometry, at } of items) {
    const count = geometry.getAttribute('position').count;
    for (const name of PILE_ATTRIBUTES) {
      const source = geometry.getAttribute(name).array as Float32Array;
      const size = name === 'uv' ? 2 : 3;
      arrays[name].set(source.subarray(0, count * size), vertex * size);
    }
    if (at[0] !== 0 || at[1] !== 0 || at[2] !== 0) {
      for (let at3 = vertex * 3, end = (vertex + count) * 3; at3 < end; at3 += 3) {
        arrays.position[at3]! += at[0];
        arrays.position[at3 + 1]! += at[1];
        arrays.position[at3 + 2]! += at[2];
      }
    }
    const source = geometry.index!.array;
    for (let at1 = 0; at1 < source.length; at1++) index[corner + at1] = source[at1]! + vertex;
    vertex += count;
    corner += source.length;
  }
  const geometry = new BufferGeometry();
  for (const name of PILE_ATTRIBUTES) geometry.setAttribute(name, new BufferAttribute(arrays[name], name === 'uv' ? 2 : 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

const moved = (at: V3, by: V3): V3 => [at[0] + by[0], at[1] + by[1], at[2] + by[2]];

/**
 * Builds laid down together as one, each moved by its `at` (an estate's parts): the piles of one material that cast
 * alike become one mesh, the scatterings of one kind one scattering. A part's piles are dozens of meshes, each drawn in
 * the picture and again for the shadows; an estate built in a dozen parts is drawn in a dozen times fewer so. The parts'
 * own geometries are let go.
 */
export function mergeBuilds(parts: readonly { build: Build; at: V3 }[]): Build {
  const piles = new Map<string, { material: Material; cast: boolean; look: Finishing | undefined; items: { geometry: BufferGeometry; at: V3 }[] }>();
  const meshes: BuiltMesh[] = [];
  const scattered = new Map<SprigKind, { matrices: Float32Array[]; colors: Float32Array[]; outs: Float32Array[]; count: number }>();
  const lamps: Lamp[] = [];
  const lives: Life[] = [];
  for (const { build, at } of parts) {
    for (const mesh of build.meshes) {
      if (!joinable(mesh.geometry)) {
        if (at[0] !== 0 || at[1] !== 0 || at[2] !== 0) mesh.geometry.translate(at[0], at[1], at[2]);
        meshes.push(mesh);
        continue;
      }
      const key = `${mesh.material.uuid}|${mesh.cast}`;
      const pile = piles.get(key) ?? { material: mesh.material, cast: mesh.cast, look: mesh.look, items: [] };
      pile.items.push({ geometry: mesh.geometry, at });
      piles.set(key, pile);
    }
    for (const sprigs of build.sprigs) {
      const matrices = sprigs.matrices.slice();
      for (let index = 0; index < sprigs.count; index++) {
        matrices[index * 16 + 12]! += at[0];
        matrices[index * 16 + 13]! += at[1];
        matrices[index * 16 + 14]! += at[2];
      }
      const kind = scattered.get(sprigs.kind) ?? { matrices: [], colors: [], outs: [], count: 0 };
      kind.matrices.push(matrices);
      kind.colors.push(sprigs.colors);
      kind.outs.push(sprigs.outs);
      kind.count += sprigs.count;
      scattered.set(sprigs.kind, kind);
    }
    for (const lamp of build.lamps) lamps.push({ ...lamp, at: moved(lamp.at, at) });
    for (const life of build.lives) lives.push({ ...life, at: moved(life.at, at) });
  }
  for (const { material, cast, look, items } of piles.values()) {
    const single = items.length === 1 && items[0]!.at.every((value) => value === 0);
    meshes.push({ geometry: single ? items[0]!.geometry : joined(items), material, cast, ...(look ? { look } : {}) });
    if (!single) for (const { geometry } of items) geometry.dispose();
  }
  const concat = (arrays: Float32Array[]) => {
    const all = new Float32Array(arrays.reduce((sum, array) => sum + array.length, 0));
    let offset = 0;
    for (const array of arrays) {
      all.set(array, offset);
      offset += array.length;
    }
    return all;
  };
  const sprigs: BuiltSprigs[] = [...scattered].map(([kind, { matrices, colors, outs, count }]) => ({ kind, count, matrices: concat(matrices), colors: concat(colors), outs: concat(outs) }));
  return { meshes, sprigs, lamps, lives };
}

export class Builder {
  /** The numbers this build scatters by: the same for the same seed. */
  readonly random: () => number;
  /** How thickly leaves, stones and flowers are scattered: 1 in full, less for a device that would labour over them. */
  density = 1;
  private readonly piles = new Map<string, Pile>();
  private readonly sprigs = new Map<SprigKind, Sprigs>();
  private readonly lamps: Lamp[] = [];
  private readonly lives: Life[] = [];
  private matrix = new Matrix4();
  private readonly local = new Matrix4();
  private readonly full = new Matrix4();
  private readonly normal = new Matrix3();
  private readonly point = new Vector3();
  private readonly quaternion = new Quaternion();
  private readonly euler = new Euler();
  private readonly scale = new Vector3();
  private readonly position = new Vector3();

  constructor(seed: number) {
    this.random = rng(seed);
  }

  /** A number between `from` and `to`. */
  between(from: number, to: number): number {
    return from + (to - from) * this.random();
  }

  /** One of `items`. */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length) % items.length]!;
  }

  /** Draws what `draw` draws moved to `at`, turned by `turn` (radians about x, y, z; a number is a turn about y) and scaled. */
  group(at: V3, draw: () => void, turn: V3 | number = 0, scale: number | V3 = 1): this {
    const outer = this.matrix;
    this.compose(at, turn, typeof scale === 'number' ? [scale, scale, scale] : scale);
    this.matrix = new Matrix4().multiplyMatrices(outer, this.local);
    draw();
    this.matrix = outer;
    return this;
  }

  private compose(at: V3, turn: V3 | number, scale: V3): void {
    if (typeof turn === 'number') this.euler.set(0, turn, 0);
    else this.euler.set(turn[0], turn[1], turn[2]);
    this.local.compose(this.position.set(at[0], at[1], at[2]), this.quaternion.setFromEuler(this.euler), this.scale.set(scale[0], scale[1], scale[2]));
  }

  private pile(finish: Finish): Pile {
    const { material, key, look } = materialOf(finish);
    const cast = !finish.shadowless && !finish.glow && (finish.opacity ?? 1) >= 1;
    const pileKey = `${key}|${cast}`;
    let pile = this.piles.get(pileKey);
    if (!pile) {
      const surface = finish.surface ?? 'plain';
      pile = { material, look, cast, tile: surface === 'plain' ? 1 : surfaceMaps(surface).size, grain: surface === 'wood', positions: [], normals: [], uvs: [], colors: [], indices: [] };
      this.piles.set(pileKey, pile);
    }
    return pile;
  }

  /**
   * Adds a copy of `template` at `at`, turned and scaled, painted `color`. `wrap` is how far round and how far along a
   * round shape's own texture runs, in metres; other shapes are textured by the face, in their own metres.
   */
  private add(template: Template, at: V3, turn: V3 | number, scale: V3, color: string, finish: Finish, wrap: [number, number] = [1, 1], pile = this.pile(finish)): void {
    this.compose(at, turn, scale);
    this.full.multiplyMatrices(this.matrix, this.local);
    this.normal.getNormalMatrix(this.full);
    const base = pile.positions.length / 3;
    const { positions, normals, uvs, indices } = template;
    const count = positions.length / 3;
    const paint = colorOf(color);
    const tone = finish.vary ? 1 + (this.random() - 0.5) * 2 * finish.vary : 1;
    const [sx, sy, sz] = scale;
    const tile = pile.tile;
    // Boards and planks run their grain along their length.
    const shiftU = pile.grain ? this.random() : 0;
    const shiftV = pile.grain ? this.random() : 0;
    for (let index = 0; index < count; index++) {
      const px = positions[index * 3]!;
      const py = positions[index * 3 + 1]!;
      const pz = positions[index * 3 + 2]!;
      const nx = normals[index * 3]!;
      const ny = normals[index * 3 + 1]!;
      const nz = normals[index * 3 + 2]!;
      this.point.set(px, py, pz).applyMatrix4(this.full);
      pile.positions.push(this.point.x, this.point.y, this.point.z);
      this.point.set(nx, ny, nz).applyMatrix3(this.normal).normalize();
      pile.normals.push(this.point.x, this.point.y, this.point.z);
      const ax = Math.abs(nx);
      const ay = Math.abs(ny);
      const az = Math.abs(nz);
      let u: number;
      let v: number;
      if (template.wrap && ay < 0.9) {
        u = uvs[index * 2]! * wrap[0];
        v = uvs[index * 2 + 1]! * wrap[1];
      } else if (ay >= ax && ay >= az) {
        [u, v] = pile.grain && sz > sx ? [pz * sz, px * sx] : [px * sx, pz * sz];
      } else if (ax >= az) {
        [u, v] = pile.grain && sy > sz ? [py * sy, pz * sz] : [pz * sz, py * sy];
      } else {
        [u, v] = pile.grain && sy > sx ? [py * sy, px * sx] : [px * sx, py * sy];
      }
      pile.uvs.push(u / tile + shiftU, v / tile + shiftV);
      pile.colors.push(paint.r * tone, paint.g * tone, paint.b * tone);
    }
    for (let index = 0; index < indices.length; index++) pile.indices.push(base + indices[index]!);
  }

  /** A box `size` wide, high and deep, centred on `at`. */
  box(size: V3, at: V3, color: string, finish: Finish = {}, turn: V3 | number = 0): this {
    this.add(BOX(), at, turn, size, color, finish);
    return this;
  }

  /** An upright cylinder centred on `at`; `top` gives it another radius at the top. */
  cyl(radius: number, height: number, at: V3, color: string, finish: Finish & { top?: number; sides?: number } = {}, turn: V3 | number = 0): this {
    const { top = radius, sides = 16 } = finish;
    const ratio = Math.round((top / radius) * 100) / 100;
    const template = templateOf(`cyl|${ratio}|${sides}`, () => new CylinderGeometry(ratio, 1, 1, sides), true);
    this.add(template, at, turn, [radius, height, radius], color, finish, [Math.PI * 2 * Math.max(radius, top), height]);
    return this;
  }

  cone(radius: number, height: number, at: V3, color: string, finish: Finish & { sides?: number } = {}, turn: V3 | number = 0): this {
    const { sides = 14 } = finish;
    const template = templateOf(`cone|${sides}`, () => new ConeGeometry(1, 1, sides), true);
    this.add(template, at, turn, [radius, height, radius], color, finish, [Math.PI * 2 * radius, Math.hypot(radius, height)]);
    return this;
  }

  /** A ball, or with `scale` an egg, a pebble, a cushion. */
  ball(radius: number, at: V3, color: string, finish: Finish & { scale?: V3; detail?: number } = {}, turn: V3 | number = 0): this {
    const { scale = [1, 1, 1], detail = 16 } = finish;
    const template = templateOf(`ball|${detail}`, () => new SphereGeometry(1, detail, Math.max(6, Math.round(detail * 0.7))), true);
    const size: V3 = [radius * scale[0], radius * scale[1], radius * scale[2]];
    this.add(template, at, turn, size, color, finish, [Math.PI * (size[0] + size[2]), Math.PI * size[1]]);
    return this;
  }

  /** The upper half of a ball, flat side down. */
  dome(size: V3, at: V3, color: string, finish: Finish & { detail?: number } = {}, turn: V3 | number = 0): this {
    const { detail = 24 } = finish;
    const template = templateOf(`dome|${detail}`, () => new SphereGeometry(1, detail, Math.round(detail / 2), 0, Math.PI * 2, 0, Math.PI / 2), true);
    this.add(template, at, turn, size, color, finish, [Math.PI * (size[0] + size[2]), Math.PI * size[1]]);
    return this;
  }

  /** A ring standing upright, facing +z: `radius` to the middle of its tube, `tube` thick, open when `arc` is less than a turn. */
  ring(radius: number, tube: number, at: V3, color: string, finish: Finish & { arc?: number } = {}, turn: V3 | number = 0): this {
    const { arc = Math.PI * 2 } = finish;
    const ratio = Math.round((tube / radius) * 1000) / 1000;
    const template = templateOf(`ring|${ratio}|${arc.toFixed(3)}`, () => new TorusGeometry(1, ratio, 8, 28, arc), true);
    this.add(template, at, turn, [radius, radius, radius], color, finish, [radius * arc, Math.PI * 2 * tube]);
    return this;
  }

  /** A gable's block `size` wide (x), high and deep (z), standing on `at`: `ridge` 1 a gable, less a hip, 0 a pyramid. */
  prism(size: V3, at: V3, color: string, finish: Finish & { ridge?: number } = {}, turn: V3 | number = 0): this {
    const { ridge = 1 } = finish;
    this.add(templateOf(`prism|${ridge}`, () => prismGeometry(ridge), false), at, turn, size, color, finish);
    return this;
  }

  /**
   * A limb: a tube through `points`, `radii` thick at each, its texture running along it. A trunk, a branch, a rope,
   * a rail's curve.
   */
  limb(points: readonly V3[], radii: readonly number[], color: string, finish: Finish & { sides?: number } = {}): this {
    const { sides = 8 } = finish;
    const pile = this.pile(finish);
    const paint = colorOf(color);
    const base = pile.positions.length / 3;
    const tangent = new Vector3();
    const side = new Vector3();
    const other = new Vector3();
    const here = new Vector3();
    this.normal.getNormalMatrix(this.matrix);
    let along = 0;
    for (let ring = 0; ring < points.length; ring++) {
      const before = points[Math.max(0, ring - 1)]!;
      const after = points[Math.min(points.length - 1, ring + 1)]!;
      const at = points[ring]!;
      if (ring > 0) along += Math.hypot(at[0] - before[0], at[1] - before[1], at[2] - before[2]);
      tangent.set(after[0] - before[0], after[1] - before[1], after[2] - before[2]).normalize();
      side.set(0, 0, 1);
      if (Math.abs(tangent.z) > 0.9) side.set(1, 0, 0);
      side.cross(tangent).normalize();
      other.crossVectors(tangent, side);
      const radius = radii[ring] ?? radii[radii.length - 1]!;
      for (let step = 0; step <= sides; step++) {
        const angle = (step / sides) * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        here.set(side.x * cos + other.x * sin, side.y * cos + other.y * sin, side.z * cos + other.z * sin);
        this.point.set(at[0] + here.x * radius, at[1] + here.y * radius, at[2] + here.z * radius).applyMatrix4(this.matrix);
        pile.positions.push(this.point.x, this.point.y, this.point.z);
        here.applyMatrix3(this.normal).normalize();
        pile.normals.push(here.x, here.y, here.z);
        pile.uvs.push(((step / sides) * Math.PI * 2 * Math.max(radius, 0.05)) / pile.tile, along / pile.tile);
        pile.colors.push(paint.r, paint.g, paint.b);
      }
    }
    const row = sides + 1;
    for (let ring = 0; ring < points.length - 1; ring++) {
      for (let step = 0; step < sides; step++) {
        const a = base + ring * row + step;
        const b = a + row;
        pile.indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    return this;
  }

  /**
   * Geometry worked out elsewhere (the island's ground), in this build's own space: positions, normals and colours
   * three numbers a corner, textures two.
   */
  raw(finish: Finish, positions: ArrayLike<number>, normals: ArrayLike<number>, uvs: ArrayLike<number>, tints: ArrayLike<number>, indices: ArrayLike<number>): this {
    const pile = this.pile(finish);
    const base = pile.positions.length / 3;
    for (let index = 0; index < positions.length; index++) pile.positions.push(positions[index]!);
    for (let index = 0; index < normals.length; index++) pile.normals.push(normals[index]!);
    for (let index = 0; index < uvs.length; index++) pile.uvs.push(uvs[index]! / pile.tile);
    for (let index = 0; index < tints.length; index++) pile.colors.push(tints[index]!);
    for (let index = 0; index < indices.length; index++) pile.indices.push(base + indices[index]!);
    return this;
  }

  /** A pane of lit glass `size` wide and high, facing +z at `at`. */
  pane(size: [number, number], at: V3, style: PaneStyle, power: number, turn: V3 | number = 0): this {
    const material = paneMaterial(style, power);
    const key = `pane|${style}|${power}`;
    let pile = this.piles.get(key);
    if (!pile) {
      pile = { material, look: { pane: style, power }, cast: false, tile: 1, grain: false, positions: [], normals: [], uvs: [], colors: [], indices: [] };
      this.piles.set(key, pile);
    }
    const from = pile.uvs.length;
    this.add(PLANE(), at, turn, [size[0], size[1], 1], '#ffffff', {}, [1, 1], pile);
    // The picture of the room fills the pane whatever its size.
    for (const [index, [u, v]] of ([[0, 1], [1, 1], [0, 0], [1, 0]] as const).entries()) {
      pile.uvs[from + index * 2] = u;
      pile.uvs[from + index * 2 + 1] = v;
    }
    return this;
  }

  /**
   * One of the small things scattered by the thousand, at `at`, `size` big, in `color`. `aim` is the way its own up
   * points (a leaf spray off its branch), `spin` its turn about that; `out` the way light should take it to face (the
   * outside of the crown it belongs to), so a crown shades as one soft mass; `shade` darkens or lightens the colour.
   */
  sprig(kind: SprigKind, at: V3, size: number | V3, color: string, aim: V3 = [0, 1, 0], spin = 0, out: V3 = aim, shade = 1): this {
    let sprigs = this.sprigs.get(kind);
    if (!sprigs) {
      sprigs = { matrices: [], colors: [], outs: [] };
      this.sprigs.set(kind, sprigs);
    }
    const scale = typeof size === 'number' ? this.scale.set(size, size, size) : this.scale.set(size[0], size[1], size[2]);
    this.quaternion.setFromUnitVectors(UP, this.point.set(aim[0], aim[1], aim[2]).normalize());
    if (spin) this.quaternion.multiply(new Quaternion().setFromAxisAngle(UP, spin));
    this.local.compose(this.position.set(at[0], at[1], at[2]), this.quaternion, scale);
    this.full.multiplyMatrices(this.matrix, this.local);
    for (let index = 0; index < 16; index++) sprigs.matrices.push(this.full.elements[index]!);
    const paint = colorOf(color);
    sprigs.colors.push(paint.r * shade, paint.g * shade, paint.b * shade);
    this.point.set(out[0], out[1], out[2]).transformDirection(this.matrix);
    sprigs.outs.push(this.point.x, this.point.y, this.point.z);
    return this;
  }

  /** A light at `at` that shines `reach` metres; a flame's `flicker`s. */
  lamp(at: V3, color: string, power: number, reach = 4, flicker = false): this {
    this.point.set(at[0], at[1], at[2]).applyMatrix4(this.matrix);
    this.lamps.push({ at: [this.point.x, this.point.y, this.point.z], color, power, reach, flicker });
    return this;
  }

  /** Something that moves, to be mounted beside the build; its place is given in the build's own space. */
  life(life: Life): this {
    this.point.set(life.at[0], life.at[1], life.at[2]).applyMatrix4(this.matrix);
    this.lives.push({ ...life, at: [this.point.x, this.point.y, this.point.z] });
    return this;
  }

  /** Everything piled up so far, as meshes and scatterings ready to mount. */
  finish(): Build {
    const meshes: BuiltMesh[] = [];
    for (const pile of this.piles.values()) {
      if (pile.indices.length === 0) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(pile.positions), 3));
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(pile.normals), 3));
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array(pile.uvs), 2));
      geometry.setAttribute('color', new BufferAttribute(new Float32Array(pile.colors), 3));
      const count = pile.positions.length / 3;
      geometry.setIndex(new BufferAttribute(count > 65535 ? new Uint32Array(pile.indices) : new Uint16Array(pile.indices), 1));
      meshes.push({ geometry, material: pile.material, cast: pile.cast, look: pile.look });
    }
    const sprigs: BuiltSprigs[] = [];
    for (const [kind, { matrices, colors: tints, outs }] of this.sprigs) {
      sprigs.push({ kind, count: tints.length / 3, matrices: new Float32Array(matrices), colors: new Float32Array(tints), outs: new Float32Array(outs) });
    }
    return { meshes, sprigs, lamps: this.lamps, lives: this.lives };
  }
}
