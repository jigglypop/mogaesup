import type { NPCInstanceData, NPCTemplate, RuntimeDomainBinding } from 'gaesup-world';

import type { CatalogItem } from '../api/types';
import { MINIME_SCALE } from './character';

/**
 * 주민: studio characters the island's owner stands on the island, each with a name and a line it says to whoever talks
 * to it. They are saved with the island (the `residents` domain of its save), so visitors meet the same ones; only the
 * catalog item is stored, and its model comes from the catalog each time the island loads.
 */
export const RESIDENTS_DOMAIN = 'residents';
/** The server's limits (`server/src/residents.rs`). */
export const MAX_RESIDENTS = 12;
export const NAME_MAX = 20;
export const GREETING_MAX = 80;
const COORDINATE_MAX = 100;
/** How close someone stands for a resident to turn to them, in meters. */
export const FACE_RADIUS = 4;
/** How close the player stands to talk to one. */
export const TALK_RANGE = 2.6;
/** Radians a second a resident turns at. */
const TURN_SPEED = 5;
/** New residents stand clear of where visitors arrive, and of each other. */
const SPAWN_CLEAR = 1.5;
const NEIGHBOR_CLEAR = 1;

export type Vec3 = [number, number, number];

export type Resident = {
  id: string;
  /** The 주민 catalog item it is. */
  npc: string;
  name: string;
  greeting: string;
  position: Vec3;
  /** Turn about Y, in radians: where it looks while nobody is near. */
  rotation: number;
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CATALOG_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const isText = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && [...value].length <= max && value.trim().length >= min && !CONTROL.test(value);
const isCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= COORDINATE_MAX;

/** Checks one saved resident; the same rules the server applies. */
function readResident(value: unknown): Resident | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const { id, npc, name, greeting, position, rotation } = entry;
  if (Object.keys(entry).length !== 6) return null;
  if (typeof id !== 'string' || !ID.test(id) || typeof npc !== 'string' || !CATALOG_ID.test(npc)) return null;
  if (!isText(name, 1, NAME_MAX) || !isText(greeting, 0, GREETING_MAX)) return null;
  if (!Array.isArray(position) || position.length !== 3 || !position.every(isCoordinate)) return null;
  if (typeof rotation !== 'number' || !Number.isFinite(rotation)) return null;
  const [x, y, z] = position as number[];
  return { id, npc, name, greeting, position: [x ?? 0, y ?? 0, z ?? 0], rotation };
}

/** The residents in a saved island's domain; throws on anything malformed, so a bad save never half-applies. */
export function parseResidents(data: unknown): Resident[] {
  if (data === null || data === undefined) return [];
  const domain = data as { version?: unknown; residents?: unknown };
  if (typeof data !== 'object' || domain.version !== 1 || !Array.isArray(domain.residents)) throw new TypeError('Invalid residents');
  if (domain.residents.length > MAX_RESIDENTS) throw new TypeError('Too many residents');
  const residents = domain.residents.map(readResident);
  const ids = new Set(residents.map((resident) => resident?.id));
  if (residents.some((resident) => !resident) || ids.size !== residents.length) throw new TypeError('Invalid resident');
  return residents as Resident[];
}

export type ResidentChanges = Partial<Pick<Resident, 'name' | 'greeting' | 'position' | 'rotation'>>;

export type ResidentStore = {
  getState: () => readonly Resident[];
  subscribe: (listener: () => void) => () => void;
  /** Advances with every change, for the island's save. */
  revision: () => number;
  replace: (next: readonly Resident[]) => void;
  /** The new resident, or null when the island is full. */
  add: (resident: Omit<Resident, 'id'>) => Resident | null;
  update: (id: string, changes: ResidentChanges) => void;
  remove: (id: string) => void;
};

const newId = () => `r${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** One island's residents. Entries are replaced, never changed in place, so each one's identity marks a change. */
export function createResidentStore(initial: readonly Resident[] = []): ResidentStore {
  let residents: readonly Resident[] = initial;
  let revision = 0;
  const listeners = new Set<() => void>();
  const set = (next: readonly Resident[]) => {
    residents = next;
    revision++;
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: () => residents,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => revision,
    replace: (next) => set([...next]),
    add(resident) {
      if (residents.length >= MAX_RESIDENTS) return null;
      const added = { ...resident, id: newId() };
      set([...residents, added]);
      return added;
    },
    update(id, changes) {
      if (!residents.some((resident) => resident.id === id)) return;
      set(residents.map((resident) => (resident.id === id ? { ...resident, ...changes } : resident)));
    },
    remove(id) {
      if (residents.some((resident) => resident.id === id)) set(residents.filter((resident) => resident.id !== id));
    },
  };
}

/** The island save's `residents` domain over `store`. */
export function residentsBinding(store: ResidentStore): RuntimeDomainBinding {
  return {
    key: RESIDENTS_DOMAIN,
    serialize: () => ({ version: 1, residents: store.getState().map((resident) => ({ ...resident, position: [...resident.position] })) }),
    hydrate: (data) => store.replace(parseResidents(data)),
    prepareHydrate: (data) => {
      const next = parseResidents(data);
      return () => store.replace(next);
    },
    owned: true,
    revision: store.revision,
    reset: () => store.replace([]),
  };
}

export const templateIdOf = (npc: string) => `resident:${npc}`;

/** The engine's NPC template for a 주민 catalog item: its model as one body part, drawn matte like a 미니미. */
export function residentTemplate(item: CatalogItem): NPCTemplate {
  return {
    id: templateIdOf(item.id),
    name: item.label,
    category: 'humanoid',
    baseParts: [{ id: 'body', type: 'body', url: item.modelUrl }],
    clothingParts: [],
    materialPolicy: 'figure',
  };
}

/** The engine's NPC for a resident: it stands in its idle, turns smoothly, and greets whoever talks to it. */
export function residentInstance(resident: Resident): NPCInstanceData {
  return {
    id: resident.id,
    templateId: templateIdOf(resident.npc),
    name: resident.name,
    position: [...resident.position],
    rotation: [0, resident.rotation, 0],
    scale: [MINIME_SCALE, MINIME_SCALE, MINIME_SCALE],
    behavior: { mode: 'idle', speed: 0, turnSpeed: TURN_SPEED, faceOnInteract: true, greetAnimation: 'wave' },
  };
}

/** Residents whose catalog item is published: the ones the island draws. */
export function shownResidents(residents: readonly Resident[], items: readonly CatalogItem[]): Resident[] {
  const published = new Set(items.map((item) => item.id));
  return residents.filter((resident) => published.has(resident.npc));
}

const distance2d = (a: readonly number[], b: readonly number[]) => Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

/**
 * Where a new resident stands: the nearest whole meter to `center` that keeps clear of where visitors arrive (`spawn`)
 * and of the other residents, searched in growing square rings; `ground` gives the height to stand at.
 */
export function residentSpot(
  center: { x: number; z: number },
  others: readonly Resident[],
  spawn: readonly number[],
  ground: (x: number, z: number) => number,
): Vec3 {
  const x0 = Math.round(center.x);
  const z0 = Math.round(center.z);
  const free = (x: number, z: number) =>
    distance2d([x, 0, z], spawn) >= SPAWN_CLEAR && others.every((other) => distance2d([x, 0, z], other.position) >= NEIGHBOR_CLEAR);
  for (let ring = 0; ring <= 6; ring++) {
    const spots: [number, number][] = [];
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === ring) spots.push([dx, dz]);
    }
    spots.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2) || Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
    for (const [dx, dz] of spots) {
      if (free(x0 + dx, z0 + dz)) return [x0 + dx, ground(x0 + dx, z0 + dz), z0 + dz];
    }
  }
  return [x0, ground(x0, z0), z0];
}

/** The point a resident looks toward: whoever stands within `FACE_RADIUS`, else straight ahead the way it was placed. */
export function lookTarget(standing: readonly number[], rotation: number, player: readonly number[] | null): { near: boolean; target: Vec3 } {
  const [x = 0, y = 0, z = 0] = standing;
  if (player && distance2d(standing, player) <= FACE_RADIUS) return { near: true, target: [player[0] ?? x, player[1] ?? y, player[2] ?? z] };
  return { near: false, target: [x + Math.sin(rotation), y, z + Math.cos(rotation)] };
}

/** The resident talking to the player now, shown in the island's greeting card. */
export type Greeting = { id: string; name: string; greeting: string };

export type GreetingStore = {
  get: () => Greeting | null;
  subscribe: (listener: () => void) => () => void;
  show: (greeting: Greeting) => void;
  hide: () => void;
};

export function createGreetingStore(): GreetingStore {
  let current: Greeting | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Greeting | null) => {
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    show: (greeting) => set(greeting),
    hide: () => set(null),
  };
}
