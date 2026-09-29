import type {
  BuildingBlockConfig,
  BuildingSerializedState,
  MeshConfig,
  PlacedObject,
  TileCategory,
  TileGroupConfig,
  WallCategory,
  WallGroupConfig,
} from 'gaesup-world/building';

/**
 * The parts of the building store an edit changes and a save writes. The store (immer) replaces a part whenever its
 * content changes and shares whatever did not change, so keeping these references keeps a step for little memory.
 */
type IslandParts = {
  meshes: ReadonlyMap<string, MeshConfig>;
  tileGroups: ReadonlyMap<string, TileGroupConfig>;
  wallGroups: ReadonlyMap<string, WallGroupConfig>;
  tileCategories: ReadonlyMap<string, TileCategory>;
  wallCategories: ReadonlyMap<string, WallCategory>;
  blocks: readonly BuildingBlockConfig[];
  objects: readonly PlacedObject[];
  showSnow: boolean;
  showFog: boolean;
  fogColor: string;
  weatherEffect: BuildingSerializedState['weatherEffect'];
  worldSurface: BuildingSerializedState['worldSurface'];
};

const PART_KEYS = [
  'meshes',
  'tileGroups',
  'wallGroups',
  'tileCategories',
  'wallCategories',
  'blocks',
  'objects',
  'showSnow',
  'showFog',
  'fogColor',
  'weatherEffect',
  'worldSurface',
] as const satisfies readonly (keyof IslandParts)[];

/** What the history needs of the building store; the engine's store fits. */
type HistoryStore = {
  getState: () => IslandParts & { hydrate: (data: BuildingSerializedState) => void };
  subscribe: (listener: (state: IslandParts, previous: IslandParts) => void) => () => void;
};

export function readParts(state: IslandParts): IslandParts {
  const parts = {} as Record<keyof IslandParts, unknown>;
  for (const key of PART_KEYS) parts[key] = state[key];
  return parts as IslandParts;
}

/** Nothing the island is made of changed: every part is the same object. */
export const sameParts = (a: IslandParts, b: IslandParts) => PART_KEYS.every((key) => Object.is(a[key], b[key]));

const sameItem = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (!sameItem(a[index], b[index])) return false;
  return true;
}

/** Groups hold the same pieces; a group that is missing on one side counts as empty there. */
function sameGroups<Group>(a: ReadonlyMap<string, Group>, b: ReadonlyMap<string, Group>, items: (group: Group) => readonly unknown[]) {
  if (a === b) return true;
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(id);
    const right = b.get(id);
    if (left !== right && !sameList(left ? items(left) : [], right ? items(right) : [])) return false;
  }
  return true;
}

/**
 * Whether two states look the same on the island: its objects, floors, walls, blocks and weather. Picking a floor or wall
 * installs its (empty) group and material, which changes the store but not the island, so it is not an undo step.
 */
function sameIsland(a: IslandParts, b: IslandParts): boolean {
  return (
    a.showSnow === b.showSnow &&
    a.showFog === b.showFog &&
    a.fogColor === b.fogColor &&
    a.weatherEffect === b.weatherEffect &&
    a.worldSurface === b.worldSurface &&
    sameList(a.objects, b.objects) &&
    sameList(a.blocks, b.blocks) &&
    sameGroups(a.tileGroups, b.tileGroups, (group) => group.tiles) &&
    sameGroups(a.wallGroups, b.wallGroups, (group) => group.walls)
  );
}

function withMissing<Item>(target: ReadonlyMap<string, Item>, current: ReadonlyMap<string, Item>, emptied?: (item: Item) => Item) {
  const merged = new Map(target);
  for (const [id, item] of current) if (!merged.has(id)) merged.set(id, emptied ? emptied(item) : item);
  return merged;
}

/**
 * `target` with the floors, walls and materials installed since, left empty: undo takes back what was placed, not the
 * floor or wall the owner has picked, so the next piece still uses it.
 */
function mergePalette(target: IslandParts, current: IslandParts): IslandParts {
  return {
    ...target,
    meshes: withMissing(target.meshes, current.meshes),
    tileGroups: withMissing(target.tileGroups, current.tileGroups, (group) => ({ ...group, tiles: [] })),
    wallGroups: withMissing(target.wallGroups, current.wallGroups, (group) => ({ ...group, walls: [] })),
    tileCategories: withMissing(target.tileCategories, current.tileCategories),
    wallCategories: withMissing(target.wallCategories, current.wallCategories),
  };
}

/** The engine's snapshot shape of `parts`; `hydrate` copies what it keeps, so the references can go in as they are. */
function toSerialized(parts: IslandParts): BuildingSerializedState {
  return {
    version: 1,
    meshes: [...parts.meshes.values()],
    wallGroups: [...parts.wallGroups.values()],
    tileGroups: [...parts.tileGroups.values()],
    blocks: [...parts.blocks],
    objects: [...parts.objects],
    showSnow: parts.showSnow,
    showFog: parts.showFog,
    fogColor: parts.fogColor,
    weatherEffect: parts.weatherEffect,
    worldSurface: parts.worldSurface,
    wallCategories: [...parts.wallCategories.values()],
    tileCategories: [...parts.tileCategories.values()],
  };
}

export type EditHistory = {
  /** Starts recording from the store as it is now, the baseline undo goes back to; call it once the island has loaded. */
  start: () => void;
  stop: () => void;
  /** Forgets every step and takes the store as it is now as the baseline (after loading another copy of the island). */
  reset: () => void;
  undo: () => boolean;
  redo: () => boolean;
  /** Records a pending change now instead of after the pause. */
  flush: () => void;
  /** Holds recording through a gesture such as a drag; the returned release records the whole gesture as one step. */
  hold: () => () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Changes with every recorded or taken-back step, for `useSyncExternalStore`. */
  version: () => number;
  subscribe: (listener: () => void) => () => void;
};

type EditHistoryOptions = {
  /** Steps kept; the oldest go first. */
  limit?: number;
  /** A pause this long ends a step, so a burst of changes (a drag painting cells) is one step. */
  pauseMs?: number;
};

/**
 * Undo and redo over the island: steps are snapshots of the building store's parts, taken after each pause in editing.
 * A change that does not show on the island (installing a floor or wall to use) makes no step, and the palette the
 * owner installed stays when a step is taken back.
 */
export function createEditHistory(store: HistoryStore, { limit = 100, pauseMs = 250 }: EditHistoryOptions = {}): EditHistory {
  // Cleared in place, never replaced: undo and redo hold these arrays while a pending change is recorded.
  const past: IslandParts[] = [];
  const future: IslandParts[] = [];
  let last: IslandParts | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let holds = 0;
  let restoring = false;
  let unsubscribe: (() => void) | null = null;
  let revision = 0;
  const listeners = new Set<() => void>();

  const notify = () => {
    revision++;
    for (const listener of [...listeners]) listener();
  };
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const commit = () => {
    cancel();
    if (!last) return;
    const next = readParts(store.getState());
    if (sameParts(next, last)) return;
    if (sameIsland(last, next)) {
      // Same island, new references: keep them so the next step's undo restores the installed palette too.
      last = next;
      return;
    }
    past.push(last);
    if (past.length > limit) past.splice(0, past.length - limit);
    future.length = 0;
    last = next;
    notify();
  };

  const changed = (state: IslandParts, previous: IslandParts) => {
    if (restoring || !last || sameParts(state, previous)) return;
    if (holds > 0) return;
    cancel();
    timer = setTimeout(commit, pauseMs);
  };

  const restore = (target: IslandParts) => {
    const state = store.getState();
    restoring = true;
    try {
      state.hydrate(toSerialized(mergePalette(target, readParts(state))));
    } finally {
      restoring = false;
    }
    last = readParts(store.getState());
  };

  const travel = (from: IslandParts[], to: IslandParts[]) => {
    if (holds > 0 || !last) return false;
    commit();
    const target = from.pop();
    if (!target || !last) return false;
    to.push(last);
    restore(target);
    notify();
    return true;
  };

  return {
    start() {
      if (unsubscribe) return;
      past.length = 0;
      future.length = 0;
      last = readParts(store.getState());
      unsubscribe = store.subscribe(changed);
      notify();
    },
    stop() {
      cancel();
      unsubscribe?.();
      unsubscribe = null;
      past.length = 0;
      future.length = 0;
      last = null;
      holds = 0;
      notify();
    },
    reset() {
      cancel();
      if (!unsubscribe) return;
      past.length = 0;
      future.length = 0;
      last = readParts(store.getState());
      notify();
    },
    undo: () => travel(past, future),
    redo: () => travel(future, past),
    flush: commit,
    hold() {
      holds++;
      cancel();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds = Math.max(0, holds - 1);
        if (holds === 0) commit();
      };
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    version: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
