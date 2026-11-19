import { BufferAttribute, BufferGeometry } from 'three';

import type { Build } from './build';
import { fromShelf, shelving, toShelf } from './shelf';

// An island is built from a few things (a house's style, accents and symbol; the page's own island from its chart's
// reading and where its bridges land), always the same way. So a build is kept and handed out again: to a neighbour's
// island whose house another neighbour shares, to the page's own island when the page comes back to it, and to the
// island the picture draws again off the page; and, between visits, from what an earlier visit kept (see shelf). What
// is kept are the build's numbers: whoever mounts it gets geometries of its own over them, so that letting go of one
// (and of its buffers on the graphics card) leaves the others drawing.

/** How many builds are kept, the ones used longest ago let go first. */
const KEEP = 24;
/**
 * How many charts' own islands are kept, the ones used longest ago let go first: the page's own and the few looked at
 * before it. An estate is some seven megabytes of numbers, and the charts it is kept for are kept all day (see engine).
 */
const KEEP_READINGS = 4;

const kept = new Map<string, Build>();
const readings = new Map<object, Map<string, Build>>();

function copy(geometry: BufferGeometry): BufferGeometry {
  const own = new BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    own.setAttribute(name, new BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized));
  }
  if (geometry.index) own.setIndex(new BufferAttribute(geometry.index.array, 1));
  return own;
}

/** `build` in geometries of the caller's own, over the same numbers. */
export function own(build: Build): Build {
  return { ...build, meshes: build.meshes.map((mesh) => ({ ...mesh, geometry: copy(mesh.geometry) })) };
}

/** Builds being read from an earlier visit's (see shelf), by key: two islands that ask for one wait for the one read. */
const reading = new Map<string, Promise<Build>>();

function keep(key: string, build: Build): void {
  kept.delete(key);
  while (kept.size >= KEEP) kept.delete(kept.keys().next().value!);
  kept.set(key, build);
}

/**
 * What `make` builds for `key`, made once and kept (see above): from this page's builds, else from an earlier visit's
 * (a promise, see shelf), else built now and kept for the next.
 */
export function keptBuild(key: string, make: () => Build): Build | Promise<Build> {
  const known = kept.get(key);
  if (known) {
    keep(key, known);
    return own(known);
  }
  if (!shelving) {
    const build = make();
    keep(key, build);
    return own(build);
  }
  let read = reading.get(key);
  if (!read) {
    read = fromShelf(key).then((shelved) => {
      reading.delete(key);
      const build = kept.get(key) ?? shelved ?? make();
      if (!shelved) toShelf(key, build);
      keep(key, build);
      return build;
    });
    read.catch(() => reading.delete(key));
    reading.set(key, read);
  }
  return read.then(own);
}

/** The builds kept for `reading`, now the ones used last (see KEEP_READINGS). */
function used(reading: object): Map<string, Build> | undefined {
  const builds = readings.get(reading);
  if (builds) {
    readings.delete(reading);
    readings.set(reading, builds);
  }
  return builds;
}

/** The page's own island kept for a chart's `reading` (the same object for the same birth all day) and `key`. */
export function keptEstate(reading: object, key: string): Build | null {
  const build = readings.get(reading)?.get(key);
  if (!build) return null;
  used(reading);
  return own(build);
}

/** Keeps the page's own island built for `reading` and `key` (see keptEstate); `build` stays the caller's. */
export function keepEstate(reading: object, key: string, build: Build): void {
  let builds = used(reading);
  if (!builds) {
    builds = new Map();
    readings.set(reading, builds);
    while (readings.size > KEEP_READINGS) readings.delete(readings.keys().next().value!);
  }
  // A reading's island is laid out again only when its bridges move: the last few are enough.
  if (builds.size >= 4) builds.delete(builds.keys().next().value!);
  builds.set(key, own(build));
}
