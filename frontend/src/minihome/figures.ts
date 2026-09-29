/** Where the site serves models and pictures; this module stays free of the engine. */

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
