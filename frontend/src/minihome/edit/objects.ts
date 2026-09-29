import {
  BUILDING_TREE_OPTIONS,
  getDefaultBuildingObject,
  type PlacedObject,
  type Position3D,
  type TileGroupConfig,
} from 'gaesup-world/building';

/** Objects stand on a 1 m grid, one to a spot: the engine's `OBJECT_SNAP_SIZE` and its placement rule. */
export const OBJECT_STEP = 1;
const SPOT = OBJECT_STEP / 2;
/** Tiles are this many meters a side per cell of their `size`. */
const CELL = 4;
const TURN = Math.PI * 2;

export type Vec3 = readonly [number, number, number];
/** A box in an object's own frame: after its scale, before its turn about Y and its position. */
export type LocalBox = { min: Vec3; max: Vec3 };
/** Bounds of the model a URL loads, in the model's own units, when they are known. */
export type ModelBounds = (url: string) => LocalBox | undefined;

/** Rounds away float noise such as -18.4 + 1 = -17.399999999999999, so saved positions stay tidy. */
const tidy = (value: number) => Math.round(value * 1000) / 1000;
export const snapToGrid = (value: number) => tidy(Math.round(value / OBJECT_STEP) * OBJECT_STEP);

export function isSpotFree(objects: readonly PlacedObject[], x: number, z: number, ignoreId?: string): boolean {
  return !objects.some(
    (object) => object.id !== ignoreId && Math.abs(object.position.x - x) < SPOT && Math.abs(object.position.z - z) < SPOT,
  );
}

/** The top of the highest tile under (x, z): where the engine stands an object placed there. */
export function groundHeightAt(tileGroups: Iterable<TileGroupConfig>, x: number, z: number): number {
  let height = 0;
  for (const group of tileGroups) {
    for (const tile of group.tiles) {
      const half = (Math.max(1, Math.round(tile.size || 1)) * CELL) / 2;
      if (Math.abs(tile.position.x - x) < half && Math.abs(tile.position.z - z) < half) height = Math.max(height, tile.position.y);
    }
  }
  return height;
}

/** Where `object` stands at (x, z): on the ground there, as far above it as it stood above the ground it left. */
export function positionAt(object: PlacedObject, x: number, z: number, tileGroups: Iterable<TileGroupConfig>): Position3D {
  const groups = [...tileGroups];
  const lift = Math.max(0, object.position.y - groundHeightAt(groups, object.position.x, object.position.z));
  return { x: tidy(x), y: tidy(groundHeightAt(groups, x, z) + lift), z: tidy(z) };
}

/** Offsets of the spots `ring` steps away (a square ring), nearest first. */
export function ringOffsets(ring: number): [number, number][] {
  const offsets: [number, number][] = [];
  for (let dx = -ring; dx <= ring; dx++) {
    for (let dz = -ring; dz <= ring; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) === ring) offsets.push([dx, dz]);
    }
  }
  // Nearest first; among equals, right, front, left, back (the order a copy looks natural in).
  const order = (dx: number, dz: number) => (Math.atan2(dz, dx) + TURN) % TURN;
  return offsets.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2) || order(...a) - order(...b));
}

/** The nearest free spot around (x, z), `step` meters apart, up to `rings` steps away; null when all are taken. */
export function freeSpotNear(objects: readonly PlacedObject[], x: number, z: number, step = OBJECT_STEP, rings = 4) {
  for (let ring = 1; ring <= rings; ring++) {
    for (const [dx, dz] of ringOffsets(ring)) {
      const spot = { x: tidy(x + dx * step), z: tidy(z + dz * step) };
      if (isSpotFree(objects, spot.x, spot.z)) return spot;
    }
  }
  return null;
}

export const normalizeAngle = (angle: number) => ((angle % TURN) + TURN) % TURN;
/** A turn in whole degrees, 0 to 359. */
export const degreesOf = (angle: number | undefined) => Math.round((normalizeAngle(angle ?? 0) * 180) / Math.PI) % 360;
export const radiansOf = (degrees: number) => Math.round(normalizeAngle((degrees * Math.PI) / 180) * 1e6) / 1e6;
/** `angle` turned by `degrees` and landed on the nearest multiple of `degrees`, so off-grid turns snap back into step. */
export function turned(angle: number | undefined, degrees: number): number {
  const step = Math.abs(degrees);
  const current = degreesOf(angle);
  const next = degrees > 0 ? Math.floor(current / step) * step + step : Math.ceil(current / step) * step - step;
  return radiansOf(((next % 360) + 360) % 360);
}

/** Drawn trees look the same from every side: the engine draws them without a turn. */
export const turnable = (object: PlacedObject) => object.type !== 'tree' && object.type !== 'sakura';

const TYPE_LABELS: Record<PlacedObject['type'], string> = {
  model: '물건',
  tree: '나무',
  sakura: '벚꽃나무',
  flag: '깃발',
  fire: '모닥불',
  billboard: '간판',
};

/** A name for the owner: the catalog's label, the tree's kind, or what kind of piece it is. */
export function objectLabel(object: PlacedObject, labels?: ReadonlyMap<string, string>): string {
  const config = object.config ?? {};
  if (object.type === 'model') {
    const id = config.modelId ?? '';
    return labels?.get(id) ?? getDefaultBuildingObject(id)?.label ?? (config.modelLabel && config.modelLabel !== id ? config.modelLabel : TYPE_LABELS.model);
  }
  if (object.type === 'tree' && config.treeKind) return BUILDING_TREE_OPTIONS.find((option) => option.type === config.treeKind)?.labelKo ?? TYPE_LABELS.tree;
  if (object.type === 'billboard' && config.billboardText) return `${TYPE_LABELS.billboard} · ${config.billboardText}`;
  return TYPE_LABELS[object.type];
}

/** The catalog size a model's `modelScale` multiplies: 1 for furniture from the studio. */
export const baseScaleOf = (object: PlacedObject) => getDefaultBuildingObject(object.config?.modelId ?? '')?.defaultScale ?? 1;

/** How much bigger than its catalog size the owner made it (1 = as placed from the drawer); null when it cannot grow. */
export function sizeOf(object: PlacedObject): number | null {
  if (object.type === 'model') return tidy((object.config?.modelScale ?? baseScaleOf(object)) / baseScaleOf(object));
  if (object.type === 'tree' || object.type === 'sakura') return tidy((object.config?.size ?? CELL) / CELL);
  return null;
}

export const SIZE_RANGE = { min: 0.5, max: 2, step: 0.1 } as const;

/** The config that draws `object` `size` times its catalog size. */
export function resized(object: PlacedObject, size: number): PlacedObject['config'] {
  const clamped = tidy(Math.min(SIZE_RANGE.max, Math.max(SIZE_RANGE.min, size)));
  if (object.type === 'model') return { ...object.config, modelScale: tidy(baseScaleOf(object) * clamped) };
  return { ...object.config, size: tidy(CELL * clamped) };
}

const box = (halfWidth: number, height: number, halfDepth = halfWidth): LocalBox => ({
  min: [-halfWidth, 0, -halfDepth],
  max: [halfWidth, height, halfDepth],
});

/**
 * The box a click picks `object` by and the selection outlines, in its own frame: a GLB model's real bounds once they
 * are known, otherwise a size by kind. Flat or thin pieces get a little depth so they can still be clicked.
 */
export function pickBoxOf(object: PlacedObject, bounds?: ModelBounds): LocalBox {
  const config = object.config ?? {};
  switch (object.type) {
    case 'model': {
      const scale = config.modelScale ?? 1;
      const known = config.modelUrl ? bounds?.(config.modelUrl) : undefined;
      if (!known) return box(0.6, 1.4);
      const min = known.min.map((value) => value * scale);
      const max = known.max.map((value) => value * scale);
      const grow = (axis: number, least: number) => {
        const lack = least - (max[axis]! - min[axis]!);
        if (lack > 0) {
          min[axis] = min[axis]! - lack / 2;
          max[axis] = max[axis]! + lack / 2;
        }
      };
      grow(0, 0.6);
      grow(2, 0.6);
      if (max[1]! - min[1]! < 0.3) max[1] = min[1]! + 0.3;
      return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] };
    }
    case 'tree':
    case 'sakura': {
      const size = config.size ?? CELL;
      return box(size * 0.4, size * 1.4);
    }
    case 'flag':
      return box(Math.max(0.5, (config.flagWidth ?? 1.5) / 2 + 0.2), 3, 0.5);
    case 'fire':
      return box(Math.max(0.4, (config.fireWidth ?? 1) / 2), Math.max(0.8, config.fireHeight ?? 1.5));
    case 'billboard': {
      const half = Math.max(0.5, (config.billboardWidth ?? 2) / 2);
      return box(half, (config.billboardElevation ?? 1) + (config.billboardHeight ?? 1) / 2 + 0.3, half);
    }
    default:
      return box(0.6, 1.4);
  }
}

export type Ray = { origin: Vec3; direction: Vec3 };

/** Distance along `ray` to `local` on an object at `position` turned by `rotation`, or null when it misses. */
export function rayHitsBox(ray: Ray, position: Position3D, rotation: number, local: LocalBox): number | null {
  return raySpan(ray, position, rotation, local)?.[0] ?? null;
}

/** Where `ray` enters and leaves `local` on an object at `position` turned by `rotation`, or null when it misses. */
function raySpan(ray: Ray, position: Position3D, rotation: number, local: LocalBox): [number, number] | null {
  // Into the object's frame: move, then turn back about Y. Lengths keep, so the distance is the world distance.
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const turn = (x: number, z: number): [number, number] => [x * cos + z * sin, -x * sin + z * cos];
  const [ox, oz] = turn(ray.origin[0] - position.x, ray.origin[2] - position.z);
  const [dx, dz] = turn(ray.direction[0], ray.direction[2]);
  const origin = [ox, ray.origin[1] - position.y, oz];
  const direction = [dx, ray.direction[1], dz];
  let near = -Infinity;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const o = origin[axis]!;
    const d = direction[axis]!;
    const min = local.min[axis]!;
    const max = local.max[axis]!;
    if (Math.abs(d) < 1e-12) {
      if (o < min || o > max) return null;
      continue;
    }
    let t0 = (min - o) / d;
    let t1 = (max - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return null;
  }
  if (far < 0) return null;
  return [Math.max(0, near), far];
}

const volumeOf = ({ min, max }: LocalBox) => (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);

/**
 * The object `ray` points at, by pick boxes. Boxes are rough, so a big one (a tree's crown) can swallow a small piece
 * standing inside it: among the boxes the ray meets before it leaves the nearest one, the smallest wins.
 */
export function pickObject(ray: Ray, objects: readonly PlacedObject[], bounds?: ModelBounds): PlacedObject | null {
  const hits: { object: PlacedObject; near: number; far: number; volume: number }[] = [];
  for (const object of objects) {
    const box = pickBoxOf(object, bounds);
    const span = raySpan(ray, object.position, object.rotation ?? 0, box);
    if (span) hits.push({ object, near: span[0], far: span[1], volume: volumeOf(box) });
  }
  if (hits.length === 0) return null;
  const first = hits.reduce((best, hit) => (hit.near < best.near ? hit : best));
  return hits.filter((hit) => hit.near <= first.far).reduce((best, hit) => (hit.volume < best.volume ? hit : best)).object;
}

/**
 * The grid axis nearest the camera's view along the ground, and the one to its right: arrow keys move a piece along
 * these, so "up" moves it away from the viewer however the view is turned.
 */
export function groundAxes(forwardX: number, forwardZ: number): { forward: [number, number]; right: [number, number] } {
  const forward: [number, number] =
    Math.abs(forwardX) > Math.abs(forwardZ) ? [Math.sign(forwardX), 0] : [0, Math.sign(forwardZ) || -1];
  return { forward, right: [-forward[1] || 0, forward[0] || 0] };
}
