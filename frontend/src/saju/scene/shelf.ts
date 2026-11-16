import { BufferAttribute, BufferGeometry, type TypedArray } from 'three';

import { materialFor, type Build, type BuiltSprigs, type Finishing, type Lamp, type Life } from './build';

// Builds this browser has made (an estate, a neighbour's house and garden, an empty lot), kept between visits in
// IndexedDB: the next visit lays the same island down from its numbers instead of building it again (the trees leaf by
// leaf, the ground corner by corner). A build is kept under what it was built from and the version of the code that
// builds it (__SAJU_SCENE__, a hash of the 섬's code made when the site is built): new code builds afresh, and what the
// old code built is let go. Nothing is kept under the dev server, whose code changes under it.

declare const __SAJU_SCENE__: string;

const VERSION = import.meta.env.DEV || typeof indexedDB === 'undefined' ? null : __SAJU_SCENE__;
const DATABASE = 'mg-saju';
/** The builds, and when each was put away (read alone, to let the oldest go without reading the builds). */
const BUILDS = 'builds';
const TIMES = 'times';
/** How many builds are kept, the ones put away longest ago let go first. */
const KEEP = 40;
/** How long after a build is made it is put away: not while the canvas is still being made ready. */
const PUT_AFTER_MS = 4000;

type Attribute = { name: string; array: TypedArray; itemSize: number; normalized: boolean };
type KeptMesh = { look: Finishing; cast: boolean; attributes: Attribute[]; index: TypedArray | null };
type Kept = { meshes: KeptMesh[]; sprigs: BuiltSprigs[]; lamps: Lamp[]; lives: Life[] };

/** Whether builds are kept between visits here. */
export const shelving = VERSION !== null;

let opened: Promise<IDBDatabase | null> | null = null;

const done = <T>(asked: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    asked.onsuccess = () => resolve(asked.result);
    asked.onerror = () => reject(asked.error);
  });

const finished = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

/** The database, opened once; what older code built is let go as it opens. Null where it cannot be opened. */
function database(): Promise<IDBDatabase | null> {
  opened ??= new Promise<IDBDatabase | null>((resolve) => {
    let asked: IDBOpenDBRequest;
    try {
      asked = indexedDB.open(DATABASE, 1);
    } catch {
      resolve(null);
      return;
    }
    asked.onupgradeneeded = () => {
      asked.result.createObjectStore(BUILDS);
      asked.result.createObjectStore(TIMES);
    };
    asked.onerror = () => resolve(null);
    asked.onblocked = () => resolve(null);
    asked.onsuccess = () => {
      const db = asked.result;
      // Another tab opening a newer version takes the database: this one lets go of it.
      db.onversionchange = () => db.close();
      resolve(db);
      void done(db.transaction(TIMES, 'readonly').objectStore(TIMES).getAllKeys())
        .then((keys) => {
          const old = keys.filter((key) => typeof key !== 'string' || !key.startsWith(`${VERSION}|`));
          if (old.length === 0) return;
          const transaction = db.transaction([BUILDS, TIMES], 'readwrite');
          for (const key of old) {
            transaction.objectStore(BUILDS).delete(key);
            transaction.objectStore(TIMES).delete(key);
          }
        })
        .catch(() => undefined);
    };
  });
  return opened;
}

/** `build` as numbers to keep, or null for one with a mesh whose material cannot be told again. */
function keptOf(build: Build): Kept | null {
  const meshes: KeptMesh[] = [];
  for (const { geometry, cast, look } of build.meshes) {
    if (!look) return null;
    const attributes = Object.entries(geometry.attributes).map(([name, attribute]) => ({
      name,
      array: (attribute as BufferAttribute).array,
      itemSize: attribute.itemSize,
      normalized: attribute.normalized,
    }));
    meshes.push({ look, cast, attributes, index: geometry.index?.array ?? null });
  }
  return { meshes, sprigs: build.sprigs, lamps: build.lamps, lives: build.lives };
}

/** The build kept numbers stand for, with geometries of its own and the materials it was made with. */
function buildOf(kept: Kept): Build {
  const meshes = kept.meshes.map(({ look, cast, attributes, index }) => {
    const geometry = new BufferGeometry();
    for (const { name, array, itemSize, normalized } of attributes) geometry.setAttribute(name, new BufferAttribute(array, itemSize, normalized));
    if (index) geometry.setIndex(new BufferAttribute(index, 1));
    return { geometry, material: materialFor(look), cast, look };
  });
  return { meshes, sprigs: kept.sprigs, lamps: kept.lamps, lives: kept.lives };
}

/** The build kept under `key` on an earlier visit, if there is one. */
export async function fromShelf(key: string): Promise<Build | null> {
  if (!VERSION) return null;
  try {
    const db = await database();
    if (!db) return null;
    const kept = await done<Kept | undefined>(db.transaction(BUILDS, 'readonly').objectStore(BUILDS).get(`${VERSION}|${key}`));
    return kept ? buildOf(kept) : null;
  } catch {
    return null;
  }
}

/** Keeps `build` under `key` for later visits: a little later, when the page is not busy. */
export function toShelf(key: string, build: Build): void {
  if (!VERSION) return;
  const name = `${VERSION}|${key}`;
  setTimeout(() => {
    const kept = keptOf(build);
    if (!kept) return;
    void database()
      .then(async (db) => {
        if (!db) return;
        const putting = db.transaction([BUILDS, TIMES], 'readwrite');
        putting.objectStore(BUILDS).put(kept, name);
        putting.objectStore(TIMES).put(Date.now(), name);
        await finished(putting);
        const times = db.transaction(TIMES, 'readonly').objectStore(TIMES);
        const [keys, ats] = await Promise.all([done(times.getAllKeys()), done(times.getAll() as IDBRequest<number[]>)]);
        if (keys.length <= KEEP) return;
        const oldest = keys.map((key, index) => [key, ats[index] ?? 0] as const).sort((a, b) => a[1] - b[1]).slice(0, keys.length - KEEP);
        const pruning = db.transaction([BUILDS, TIMES], 'readwrite');
        for (const [key] of oldest) {
          pruning.objectStore(BUILDS).delete(key);
          pruning.objectStore(TIMES).delete(key);
        }
      })
      .catch(() => undefined);
  }, PUT_AFTER_MS);
}

/** A short name for a long string (FNV-1a, two ways): what a chart's reading is kept under. */
export function nameOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}
