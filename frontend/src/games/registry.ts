import { draw } from './draw';
import type { GameDefinition } from './game';
import { ox } from './ox';
import { impostor } from './impostor';
import { redlight } from './redlight';
import { tag } from './tag';
import { treasure } from './treasure';

/**
 * The plugin point: every game the dock offers, in this order. A game is a folder `./<name>/` whose `index.ts` exports
 * its `defineGame(...)`, imported above and listed on one line below (see docs/game-plugins.md).
 */
export const GAMES: readonly GameDefinition[] = [
  treasure,
  ox,
  impostor,
  redlight,
  tag,
  draw,
];

export const gameOf = (kind: string | null | undefined): GameDefinition | null => GAMES.find((game) => game.kind === kind) ?? null;
