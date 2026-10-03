import { Box3 } from 'three';

import { gltfAssetCache } from 'gaesup-world';

import type { LocalBox, Vec3 } from './objects';

/** Bounds per model URL: a box once measured, null while measuring or after a failure (the kind's size stands in). */
const measured = new Map<string, LocalBox | null>();
const pending = new Map<string, Promise<LocalBox>>();
const listeners = new Set<() => void>();
let version = 0;

export function loadModelBounds(url: string): Promise<LocalBox> {
  const known = measured.get(url);
  if (known) return Promise.resolve(known);
  const underway = pending.get(url);
  if (underway) return underway;
  measured.set(url, null);
  // The world already holds every placed model, so this lease reads the shared cache instead of downloading again.
  const request = gltfAssetCache.acquire(url).then(
    ({ gltf, release }) => {
      try {
        gltf.scene.updateMatrixWorld(true);
        const box = new Box3().setFromObject(gltf.scene, true);
        if (box.isEmpty()) throw new Error('모델의 크기를 측정할 수 없어요.');
        const bounds = { min: box.min.toArray() as unknown as Vec3, max: box.max.toArray() as unknown as Vec3 };
        measured.set(url, bounds);
        version++;
        for (const listener of [...listeners]) listener();
        return bounds;
      } finally {
        release();
      }
    },
  ).finally(() => pending.delete(url));
  pending.set(url, request);
  return request;
}

/** The model's own bounds at `url` when known; the first ask starts measuring it. */
export function modelBounds(url: string): LocalBox | undefined {
  const box = measured.get(url);
  if (box) return box;
  if (!measured.has(url)) void loadModelBounds(url).catch(() => {});
  return undefined;
}

/** Changes whenever another model's bounds become known, for `useSyncExternalStore`. */
export const boundsVersion = () => version;

/** Calls `listener` whenever another model's bounds become known. */
export function subscribeBounds(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
