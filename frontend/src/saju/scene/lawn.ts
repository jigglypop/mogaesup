import { BufferAttribute, BufferGeometry, DataTexture, DoubleSide, FrontSide, InstancedBufferAttribute, InstancedBufferGeometry, LinearFilter, Mesh, RepeatWrapping, RedFormat, RGBAFormat, Sphere, SRGBColorSpace, Vector3, type Camera, type OrthographicCamera } from 'three';
import { attribute, Break, cos, dot, float, floor, Fn, fract, hash, If, int, length, Loop, max, min, mix, modelWorldMatrix, normalize, positionGeometry, screenCoordinate, sin, smoothstep, texture, transformNormalToView, uniform, vec2, vec3, vec4, vertexStage } from 'three/tsl';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';

import type { BuiltSprigs } from './build';
import { fbm } from './noise';
import { WIND_ANGLE } from './ocean/waves';
import { wind } from './sprigs';

// The lawn, in two layers that the sea's wind sways together. Below, turf: thousands of fine blades to the square metre,
// as close as a mown lawn's, so that no ground shows between them. It is one surface over the lawn, whose every pixel
// follows the camera's line of sight down through the turf (a few steps, from the blades' tops to the ground) to the
// first blade it meets, every blade narrower the higher it is, and is lit once, as that blade. Above it, blades of
// their own: some hundred to the square metre, each a curved strip that the
// wind bends from its root on the graphics card, copies of one small shape placed over the lawn in tiles (a tile the
// camera does not see is not drawn), fewer of them drawn the farther the camera stands. Where grass grows, and in what
// greens, comes from the lawn's tufts as the builders sow them (Builder's 'blade' sprigs), laid into a small picture of
// the lawn. The wind leans the blades downwind, more where a gust passes over (a moving pattern, so a gust is seen as a
// lighter wave going over the grass); the light the grass takes turns with it.

/** How high the turf stands, in metres, and how far apart its blades grow. */
const HEIGHT = 0.07;
const CELL = 0.045;
/** Steps down through the turf: under the blades, and alone (taller) on a lawn sown thin, for a device that would labour over the blades. */
const STEPS = 10;
const THIN_STEPS = 7;
const THIN_HEIGHT = 0.1;
/** Blades to the square metre at the closest look, and how tall and wide one is at most (metres). */
const BLADES_PER_METRE = 120;
const BLADE_HEIGHT = 0.24;
const BLADE_WIDTH = 0.022;
/** Metres a tile of blades is across: what the camera does not see of the lawn is left out a tile at a time. */
const BLADE_TILE = 14;
/**
 * Pixels a metre of the picture shows (the camera's zoom) at which a share of the blades is drawn, and at which all of
 * them; below the first, a quarter. A far look draws fewer blades, each still seen; the turf beneath keeps the lawn full.
 */
const FEW_AT = 20;
const ALL_AT = 80;
const FEWEST = 0.25;
/** Tufts sown to the square metre below which a lawn counts as sown thin (estateHome sows 30, thin 0.45 of that). */
const THIN_SOWING = 20;
/** Metres of lawn a texel of its picture covers, at most that many texels across; how far a tuft's green spreads. */
const TEXEL = 0.16;
const MOST_TEXELS = 384;
const SPREAD = 0.34;

/** The wind the sea is blown by, as the lawn lies: the way it blows and the way across it. */
const BLOW = vec2(Math.cos(WIND_ANGLE), Math.sin(WIND_ANGLE));
const ACROSS = vec2(-Math.sin(WIND_ANGLE), Math.cos(WIND_ANGLE));
/** How far a blade's tip leans downwind in the breeze, and further in a gust; its own flutter across the wind (metres). */
const BREEZE = 0.025;
const GUST = 0.07;
const FLUTTER = 0.012;
/** How fast a gust runs over the ground (metres a second), how long and wide one is (metres); how fast blades flutter. */
const GUST_SPEED = 2.6;
const GUST_LENGTH = 11;
const GUST_WIDTH = 19;
const FLUTTER_RATE = 4.6;

/** Gusts and calm, a pattern repeating every 64 texels; also, read still and large, where the turf grows a little taller. */
let gusts: DataTexture | null = null;
function gustMap(): DataTexture {
  if (gusts) return gusts;
  const size = 64;
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = fbm((x + 0.5) / size, (y + 0.5) / size, 4, 3, 211);
      const strong = Math.min(1, Math.max(0, (value - 0.32) / 0.42));
      data[y * size + x] = Math.round(strong * strong * (3 - 2 * strong) * 255);
    }
  }
  gusts = new DataTexture(data, size, size, RedFormat);
  gusts.wrapS = gusts.wrapT = RepeatWrapping;
  gusts.magFilter = gusts.minFilter = LinearFilter;
  gusts.generateMipmaps = false;
  gusts.needsUpdate = true;
  return gusts;
}

/** A lawn's picture: where it grows (alpha, 0 to 1) and its green there, over the rectangle from `min`, `size` metres. */
type Turf = { texture: DataTexture; min: [number, number]; size: [number, number]; base: number; tufts: number; area: number; texels: [number, number] };

const encode = (linear: number) => Math.round(255 * Math.min(1, Math.max(0, linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055)));

/** The lawn's tufts laid into its picture: each spreads its green a little way about it, and many together make lawn. */
function turfOf({ count, matrices, colors }: BuiltSprigs): Turf | null {
  if (count === 0) return null;
  let [minX, minZ, maxX, maxZ, base] = [Infinity, Infinity, -Infinity, -Infinity, 0];
  for (let index = 0; index < count; index++) {
    const x = matrices[index * 16 + 12]!;
    const z = matrices[index * 16 + 14]!;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    base += matrices[index * 16 + 13]!;
  }
  base /= count;
  [minX, minZ, maxX, maxZ] = [minX - SPREAD, minZ - SPREAD, maxX + SPREAD, maxZ + SPREAD];
  const across = Math.max(4, Math.min(MOST_TEXELS, Math.ceil((maxX - minX) / TEXEL)));
  const down = Math.max(4, Math.min(MOST_TEXELS, Math.ceil((maxZ - minZ) / TEXEL)));
  const [stepX, stepZ] = [(maxX - minX) / across, (maxZ - minZ) / down];
  const weight = new Float32Array(across * down);
  const paint = new Float32Array(across * down * 3);
  const reach = Math.ceil(SPREAD / Math.min(stepX, stepZ));
  for (let index = 0; index < count; index++) {
    const fx = (matrices[index * 16 + 12]! - minX) / stepX - 0.5;
    const fz = (matrices[index * 16 + 14]! - minZ) / stepZ - 0.5;
    const [r, g, b] = [colors[index * 3]!, colors[index * 3 + 1]!, colors[index * 3 + 2]!];
    for (let tz = Math.max(0, Math.floor(fz) - reach); tz <= Math.min(down - 1, Math.ceil(fz) + reach); tz++) {
      for (let tx = Math.max(0, Math.floor(fx) - reach); tx <= Math.min(across - 1, Math.ceil(fx) + reach); tx++) {
        const distance = Math.hypot((tx - fx) * stepX, (tz - fz) * stepZ) / SPREAD;
        if (distance >= 1) continue;
        const w = (1 - distance * distance) ** 2;
        const at = tz * across + tx;
        weight[at] = weight[at]! + w;
        paint[at * 3] = paint[at * 3]! + r * w;
        paint[at * 3 + 1] = paint[at * 3 + 1]! + g * w;
        paint[at * 3 + 2] = paint[at * 3 + 2]! + b * w;
      }
    }
  }
  const data = new Uint8Array(across * down * 4);
  let area = 0;
  for (let at = 0; at < across * down; at++) {
    const w = weight[at]!;
    const grown = 1 - Math.exp(-w * 1.4);
    if (grown > 0.5) area += stepX * stepZ;
    const share = w > 0 ? 1 / w : 0;
    data[at * 4] = encode(paint[at * 3]! * share);
    data[at * 4 + 1] = encode(paint[at * 3 + 1]! * share);
    data[at * 4 + 2] = encode(paint[at * 3 + 2]! * share);
    data[at * 4 + 3] = Math.round(grown * 255);
  }
  const picture = new DataTexture(data, across, down, RGBAFormat);
  picture.colorSpace = SRGBColorSpace;
  picture.magFilter = picture.minFilter = LinearFilter;
  picture.generateMipmaps = false;
  picture.needsUpdate = true;
  return { texture: picture, min: [minX, minZ], size: [maxX - minX, maxZ - minZ], base, tufts: count, area, texels: [across, down] };
}

/** Numbers that look random and are the same for the same seed (mulberry32). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where the lawn's blades stand, tile by tile: one in each cell of a grid as fine as {@link BLADES_PER_METRE}, off the
 * cell's middle, where the lawn's picture says grass grows (fewer, and shorter, toward its edge). Each blade is its
 * place, a seed and its size; a tile's blades are in no order, so that the first of them, however many, are spread
 * over the whole tile (see FEW_AT).
 */
function bladesOf(turf: Turf): { blades: Float32Array; centre: [number, number]; radius: number }[] {
  const { texture: picture, min: [minX, minZ], size: [width, depth], texels: [across, down] } = turf;
  const alpha = picture.image.data as Uint8Array;
  const spacing = 1 / Math.sqrt(BLADES_PER_METRE);
  const [columns, rows] = [Math.ceil(width / spacing), Math.ceil(depth / spacing)];
  const [tilesX, tilesZ] = [Math.max(1, Math.ceil(width / BLADE_TILE)), Math.max(1, Math.ceil(depth / BLADE_TILE))];
  const tiles: number[][] = Array.from({ length: tilesX * tilesZ }, () => []);
  const random = seeded(Math.round(minX * 131 + minZ * 977 + turf.tufts));
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = minX + (column + random()) * spacing;
      const z = minZ + (row + random()) * spacing;
      const tx = Math.min(across - 1, Math.max(0, Math.floor(((x - minX) / width) * across)));
      const tz = Math.min(down - 1, Math.max(0, Math.floor(((z - minZ) / depth) * down)));
      const grown = alpha[(tz * across + tx) * 4 + 3]! / 255;
      if (random() >= grown * 1.15 - 0.1) continue;
      const tile = Math.min(tilesZ - 1, Math.floor((z - minZ) / BLADE_TILE)) * tilesX + Math.min(tilesX - 1, Math.floor((x - minX) / BLADE_TILE));
      tiles[tile]!.push(x, z, random(), 0.6 + 0.4 * Math.min(1, grown));
    }
  }
  return tiles.flatMap((list, index) => {
    if (list.length === 0) return [];
    const blades = new Float32Array(list);
    // In no order: swapped about four numbers at a time.
    for (let at = blades.length / 4 - 1; at > 0; at--) {
      const other = Math.floor(random() * (at + 1));
      for (let k = 0; k < 4; k++) {
        const kept = blades[at * 4 + k]!;
        blades[at * 4 + k] = blades[other * 4 + k]!;
        blades[other * 4 + k] = kept;
      }
    }
    const [col, row] = [index % tilesX, Math.floor(index / tilesX)];
    const centre: [number, number] = [minX + (col + 0.5) * BLADE_TILE, minZ + (row + 0.5) * BLADE_TILE];
    return [{ blades, centre, radius: (BLADE_TILE * Math.SQRT2) / 2 + BLADE_HEIGHT }];
  });
}

/** A blade's shape: rows of corners up it (how far up, and which side), three segments to its tip. */
let bladeShape: InstancedBufferGeometry | null = null;
function shapeOfBlade(): InstancedBufferGeometry {
  if (bladeShape) return bladeShape;
  const rows = [0, 0.38, 0.7];
  const shape: number[] = [];
  for (const t of rows) shape.push(t, -1, t, 1);
  shape.push(1, 0);
  const geometry = new InstancedBufferGeometry();
  // Three needs a position to count corners by; the blade's own are worked out in the vertex shader.
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(shape.length * 1.5), 3));
  geometry.setAttribute('aShape', new BufferAttribute(new Float32Array(shape), 2));
  geometry.setIndex([0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4, 4, 5, 6]);
  bladeShape = geometry;
  return geometry;
}

/** One number for a cell of the lawn, 0 to 1, the same every frame: its blade's height, place and shade. */
const cellHash = (cell: Node<'vec2'>, salt: number) => hash(cell.x.add(20011).mul(7919).add(cell.y.add(20011).mul(104729)).add(salt));

/**
 * The way the camera looks, in the village (an orthographic camera looks one way at every pixel): set before the turf
 * is drawn (see lawnMeshes).
 */
const looking = uniform(new Vector3(0, -1, 0));

/**
 * The turf's material for one lawn's picture (`turf`), `stand` metres high, followed down in `steps`: the line of sight
 * through a pixel is followed from the turf's top to the ground, and the first blade it meets gives the pixel its
 * height in the turf (the ground, under them all, if it meets none). A blade at a height is there if it grows that
 * tall (its own seed, the ground's swell, thinner at the lawn's edge) and the point lies within its width there,
 * leaning with the wind more the higher it is. Lit once, as that blade.
 */
function turfMaterial(turf: Turf, steps: number, stand: number): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, side: FrontSide });
  const ground = vertexStage(positionGeometry.xz);
  const world = vertexStage(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xz);
  const map = gustMap();

  // Where the lawn is, and its green there.
  const at = ground.sub(vec2(turf.min[0], turf.min[1])).div(vec2(turf.size[0], turf.size[1]));
  const lawn = texture(turf.texture, at);

  // The wind where the turf grows in the village: a breeze, gusts moving downwind over a pattern laid along it, and a
  // flutter across it, as far as a blade's tip leans; a blade bends more the higher up it is.
  const along = dot(world, BLOW);
  const gust = texture(map, vec2(along.sub(wind.mul(GUST_SPEED)).div(GUST_LENGTH), dot(world, ACROSS).div(GUST_WIDTH))).r;
  const flutter = sin(wind.mul(FLUTTER_RATE).add(along.mul(1.7)).add(dot(world, ACROSS).mul(0.9))).mul(FLUTTER);
  const lean = BLOW.mul(gust.mul(GUST).add(BREEZE)).add(ACROSS.mul(flutter));
  const swell = texture(map, ground.div(3.7)).r.mul(0.35).add(0.82).mul(smoothstep(0.08, 0.6, lawn.a));
  // Down the line of sight: across the ground by this much for each metre it falls.
  const slant = looking.xz.div(looking.y.min(-0.05));

  const found = Fn(() => {
    const hit = float(0).toVar();
    const shadeOf = float(0.5).toVar();
    Loop({ start: int(0), end: int(steps), condition: '<' }, ({ i }) => {
      const height = float(1).sub(i.toFloat().add(0.5).div(steps));
      const spot = ground.add(slant.mul(height.mul(stand))).sub(lean.mul(height.mul(height))).div(CELL);
      const cell = floor(spot);
      const seed = cellHash(cell, 0);
      const tall = mix(float(0.55), float(1), seed).mul(swell);
      const off = vec2(cellHash(cell, 1), cellHash(cell, 2)).sub(0.5).mul(0.46);
      const away = length(fract(spot).sub(0.5).sub(off));
      const width = max(float(0), float(1).sub(height.div(max(tall, float(0.001))))).pow(0.6).mul(0.66);
      If(height.lessThan(tall).and(away.lessThan(width)), () => {
        hit.assign(height);
        shadeOf.assign(seed);
        Break();
      });
    });
    return vec2(hit, shadeOf);
  })();
  const height = found.x;

  // Dark at the foot, where the light does not reach, light and a little warm at the tip; each blade its own shade; a
  // gust lays the blades over and the lawn shows lighter where it passes.
  const shade = mix(float(0.5), float(1.06), height).mul(found.y.sub(0.5).mul(0.14).add(1));
  const warm = mix(vec3(1), vec3(1.04, 1.04, 0.9), height.mul(height).mul(0.5));
  material.colorNode = lawn.rgb.mul(shade).mul(warm).mul(gust.mul(height).mul(0.22).add(1));
  // Lit as the lawn is, its blades leaning with the wind; past the lawn's edge, the ground beneath shows (in a fine
  // scatter, so the edge is not a line).
  material.normalNode = transformNormalToView(normalize(vec3(lean.x.mul(5), 1, lean.y.mul(5))));
  material.maskNode = lawn.a.greaterThan(hash(screenCoordinate.x.add(screenCoordinate.y.mul(4099))).mul(0.6).add(0.2));
  return material;
}

/**
 * The blades' material for one lawn: each blade stands at its root on the lawn, faces its own way and leans its own
 * way, and the wind bends it further as an arc from its root (keeping its length); it narrows to its tip, its normal
 * rounded across its width so it takes the light as a blade, not as a flat card. Its green is the lawn's where it
 * stands, dark at the root and light and warm at the tip, a little lighter in a gust.
 */
function bladeMaterial(turf: Turf): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0, side: DoubleSide });
  const blade = attribute('aBlade', 'vec4');
  const shape = attribute('aShape', 'vec2');
  const [t, side] = [shape.x, shape.y];
  const [x, z, seed, size] = [blade.x, blade.y, blade.z, blade.w];
  const base = float(turf.base);

  const turn = seed.mul(Math.PI * 2);
  const facing = vec2(cos(turn), sin(turn));
  const tall = mix(float(0.65), float(1.2), fract(seed.mul(13.7))).mul(size).mul(BLADE_HEIGHT);
  const own = mix(float(0.15), float(0.55), fract(seed.mul(31.3)));

  const world = modelWorldMatrix.mul(vec4(x, base, z, 1)).xz;
  const along = dot(world, BLOW);
  const gust = texture(gustMap(), vec2(along.sub(wind.mul(GUST_SPEED)).div(GUST_LENGTH), dot(world, ACROSS).div(GUST_WIDTH))).level(float(0)).r;
  const flutter = sin(wind.mul(FLUTTER_RATE * 1.3).add(seed.mul(40)).add(along.mul(1.7))).mul(0.09);
  const bend = facing.mul(own).add(BLOW.mul(gust.mul(0.85).add(0.28))).add(ACROSS.mul(flutter));
  const amount = min(max(length(bend), float(0.001)), float(1.25));
  const toward = bend.div(length(bend).max(0.001));
  const angle = amount.mul(t);
  const reach = tall.mul(float(1).sub(cos(angle))).div(amount);
  const rise = tall.mul(sin(angle)).div(amount);
  const wide = vec2(toward.y.negate(), toward.x);
  const half = float(1).sub(t).pow(0.85).mul(BLADE_WIDTH * 0.5).mul(size);
  material.positionNode = vec3(x.add(toward.x.mul(reach)).add(wide.x.mul(half).mul(side)), base.add(rise), z.add(toward.y.mul(reach)).add(wide.y.mul(half).mul(side)));

  // The blade's face turns with its bend, rounded across its width.
  const tangent = vec3(toward.x.mul(sin(angle)), cos(angle), toward.y.mul(sin(angle)));
  const across = vec3(wide.x, 0, wide.y);
  const face = across.cross(tangent);
  const upward = face.y.lessThan(0).select(face.negate(), face);
  material.normalNode = normalize(vertexStage(transformNormalToView(normalize(upward.add(across.mul(side.mul(0.55))).add(vec3(0, 0.35, 0))))));

  const at = vec2(x, z).sub(vec2(turf.min[0], turf.min[1])).div(vec2(turf.size[0], turf.size[1]));
  const green = texture(turf.texture, at).level(float(0)).rgb;
  const shade = mix(float(0.5), float(1.14), t.pow(0.9)).mul(fract(seed.mul(7.1)).sub(0.5).mul(0.18).add(1));
  const warm = mix(vec3(1), vec3(1.05, 1.05, 0.86), t.mul(t).mul(0.45));
  material.colorNode = vertexStage(green.mul(shade).mul(warm).mul(gust.mul(t).mul(0.18).add(1)));
  return material;
}

/** The share of a tile's blades drawn for a camera that shows `perMetre` pixels to a metre (see FEW_AT). */
const shareFor = (perMetre: number) => Math.min(1, Math.max(FEWEST, FEWEST + ((perMetre - FEW_AT) / (ALL_AT - FEW_AT)) * (1 - FEWEST)));

const centre = new Vector3();

/**
 * The lawn's tufts (`sprigs` of kind 'blade') as grass: the turf, one mesh, and the blades over it, a mesh for each tile
 * of the lawn; a lawn the builders sowed thin (for a device that would labour over it) is turf alone, a little taller.
 */
export function lawnMeshes(sprigs: BuiltSprigs): Mesh[] {
  const turf = turfOf(sprigs);
  if (!turf) return [];
  const thin = turf.area > 0 && turf.tufts / turf.area < THIN_SOWING;
  const height = thin ? THIN_HEIGHT : HEIGHT;
  const [x0, z0] = turf.min;
  const [x1, z1] = [x0 + turf.size[0], z0 + turf.size[1]];
  const y = turf.base + 0.004;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  centre.set((x0 + x1) / 2, y, (z0 + z1) / 2);
  geometry.boundingSphere = new Sphere(centre.clone(), Math.hypot(turf.size[0], turf.size[1]) / 2 + height + 0.2);
  const turfLook = turfMaterial(turf, thin ? THIN_STEPS : STEPS, height);
  const shells = new Mesh(geometry, turfLook);
  shells.name = 'turf';
  shells.castShadow = false;
  shells.receiveShadow = true;
  // Drawn after what stands on the lawn, so that what those hide is never shaded.
  shells.renderOrder = 1;
  shells.onBeforeRender = (_renderer, _scene, camera: Camera) => {
    camera.getWorldDirection(looking.value);
  };
  const meshes = [shells];
  const bladeLook = thin ? null : bladeMaterial(turf);
  if (bladeLook) {
    const shape = shapeOfBlade();
    for (const tile of bladesOf(turf)) {
      const blades = new InstancedBufferGeometry();
      // Its own copy of the blade's shape: a lawn let go takes its buffers with it, while another lawn's grow on.
      blades.index = shape.index!.clone();
      blades.setAttribute('position', shape.getAttribute('position').clone());
      blades.setAttribute('aShape', shape.getAttribute('aShape').clone());
      blades.setAttribute('aBlade', new InstancedBufferAttribute(tile.blades, 4));
      const all = tile.blades.length / 4;
      blades.instanceCount = all;
      blades.boundingSphere = new Sphere(new Vector3(tile.centre[0], turf.base + BLADE_HEIGHT / 2, tile.centre[1]), tile.radius);
      const mesh = new Mesh(blades, bladeLook);
      mesh.name = 'blades';
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      // As many of the tile's blades as the camera's distance calls for (see FEW_AT).
      mesh.onBeforeRender = (_renderer, _scene, camera: Camera) => {
        const zoom = (camera as OrthographicCamera).isOrthographicCamera ? (camera as OrthographicCamera).zoom : ALL_AT;
        blades.instanceCount = Math.max(1, Math.round(all * shareFor(zoom)));
      };
      meshes.push(mesh);
    }
  }
  // The lawn's own materials and picture go with its turf (see Built).
  shells.userData['letGo'] = () => {
    turfLook.dispose();
    bladeLook?.dispose();
    turf.texture.dispose();
  };
  return meshes;
}
