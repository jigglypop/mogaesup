import type { GameDefinition } from './game';
import { impostor } from './impostor';

/**
 * The plugin point: every game the dock offers, in this order. A game is a folder `./<name>/` whose `index.ts` exports
 * its `defineGame(...)`, imported above and listed on one line below (see docs/game-plugins.md).
 */
export const GAMES: readonly GameDefinition[] = [impostor];

export const gameOf = (kind: string | null | undefined): GameDefinition | null => GAMES.find((game) => game.kind === kind) ?? null;
