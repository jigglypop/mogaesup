import type { BuildingSerializedState } from 'gaesup-world/building';

import { forest } from './islands/forest';
import { SPAWN } from './islands/kit';

export { at, CELL, SPAWN } from './islands/kit';

/**
 * Saves are kept per version: bumping it would start every island over from the forest. The kind an island was made
 * from goes in its save instead (`islands/domain.ts`), so new kinds and fixes to a kind reach new islands only.
 */
export const VILLAGE_VERSION = 6;

/** How far from the crossroads a visitor starts, so the owner and visitors do not start inside one another. */
const VISITOR_SPAWN_RADIUS = 1.6;

/** Where `visitor` starts: the owner (null) at the crossroads, each visitor at their own spot on the crossroads. */
export function spawnFor(visitor: string | null): [number, number, number] {
  if (!visitor) return SPAWN;
  let hash = 2166136261;
  for (let index = 0; index < visitor.length; index += 1) hash = Math.imul(hash ^ visitor.charCodeAt(index), 16777619);
  const angle = ((hash >>> 0) / 2 ** 32) * Math.PI * 2;
  return [SPAWN[0] + Math.cos(angle) * VISITOR_SPAWN_RADIUS, SPAWN[1], SPAWN[2] + Math.sin(angle) * VISITOR_SPAWN_RADIUS];
}

/** The island a home starts with before its owner picks a kind: the forest. */
export const createVillage = (): BuildingSerializedState => forest.build();
