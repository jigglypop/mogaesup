import type { Resident } from '../residents';
import { beach } from './beach';
import { cafe } from './cafe';
import { camp } from './camp';
import { city } from './city';
import { DEFAULT_ISLAND } from './domain';
import { farm } from './farm';
import { forest } from './forest';
import { park } from './park';
import type { IslandId, IslandTemplate } from './types';
import { winter } from './winter';

export type { IslandId, IslandTemplate } from './types';

/** Every kind of island, in the order the chooser shows them. */
export const ISLANDS: readonly IslandTemplate[] = [forest, city, cafe, park, farm, beach, camp, winter];

const BY_ID = new Map(ISLANDS.map((template) => [template.id, template]));
export const templateOf = (id: IslandId): IslandTemplate => BY_ID.get(id) ?? BY_ID.get(DEFAULT_ISLAND)!;

/**
 * The residents as they stand on an island turned into `template`: each keeps its name and words and takes the
 * template's next spot, facing the way visitors come from. A resident past the spots keeps its own place.
 */
export function placeResidents(residents: readonly Resident[], template: IslandTemplate): Resident[] {
  return residents.map((resident, index) => {
    const spot = template.residentSpots[index];
    return spot ? { ...resident, position: [spot[0], 0, spot[1]], rotation: 0 } : resident;
  });
}
