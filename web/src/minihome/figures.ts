/** Model files the island always draws, and where the site serves them; this module stays free of the engine. */

/** The residents' models (`gltf/<id>.glb`). `Resident.model` takes only these, so the list cannot drift. */
export const RESIDENT_MODELS = [
  'teacher',
  'docter',
  'nurse',
  'man',
  'mountain',
  'police',
  'police2',
  'boy',
  'glass',
  'fish',
] as const;
export type ResidentModel = (typeof RESIDENT_MODELS)[number];

export const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`;
export const modelUrl = (id: string) => asset(`gltf/${id}.glb`);

/**
 * Starts downloading models into the HTTP cache while the island's code is still on its way; the engine's loaders
 * then find them there (a request for a file still arriving waits for it). Built pages only: the dev server's files
 * are not cacheable.
 */
export function prefetchModels(urls: readonly string[]): void {
  if (!import.meta.env.PROD) return;
  for (const url of new Set(urls)) {
    fetch(url)
      .then((response) => response.arrayBuffer())
      .catch(() => undefined);
  }
}
