import type { CatalogItem, Look } from '../api/types';
import { fallbackModelUrl } from './figures';

/**
 * The model someone walks as: their own look from the wardrobe while they wear one that finished, else their 미니미
 * from the published catalog, else the fallback figure (a pick the catalog no longer offers falls back too).
 */
export function playerModelUrl(look: Look | null | undefined, minime: string, minimes: readonly CatalogItem[]): string {
  if (look?.worn && look.modelUrl) return look.modelUrl;
  return minimes.find((item) => item.id === minime)?.modelUrl ?? fallbackModelUrl();
}

/** Whether the look shows on the island now: worn, and with a finished model. */
export const wearsLook = (look: Look | null | undefined): boolean => !!look?.worn && !!look.modelUrl;

/** How much larger than their files every character stands on the island: the player, visitors and residents alike. */
export const MINIME_SCALE = 1.5;
