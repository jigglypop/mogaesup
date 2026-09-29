import { Box3 } from 'three';

import { gltfAssetCache } from 'gaesup-world';

import type { LocalBox, Vec3 } from './objects';

/** Bounds per model URL: a box once measured, null while measuring or after a failure (the kind's size stands in). */
const measured = new Map<string, LocalBox | null>();
const listeners = new Set<() => void>();
let version = 0;

function measure(url: string) {
  measured.set(url, null);
  // The world already holds every placed model, so this lease reads the shared cache instead of downloading again.
  gltfAssetCache.acquire(url).then(
    ({ gltf, release }) => {
      try {
        gltf.scene.updateMatrixWorld(true);
        const box = new Box3().setFromObject(gltf.scene, true);
        if (box.isEmpty()) return;
        measured.set(url, { min: box.min.toArray() as unknown as Vec3, max: box.max.toArray() as unknown as Vec3 });
        version++;
        for (const listener of [...listeners]) listener();
      } finally {
        release();
      }
    },
    () => {},
  );
}

/** The model's own bounds at `url` when known; the first ask starts measuring it. */
export function modelBounds(url: string): LocalBox | undefined {
  const box = measured.get(url);
  if (box) return box;
  if (!measured.has(url)) measure(url);
  return undefined;
}

/** Changes whenever another model's bounds become known, for `useSyncExternalStore`. */
export const boundsVersion = () => version;

/** Calls `listener` whenever another model's bounds become known. */
export function subscribeBounds(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
