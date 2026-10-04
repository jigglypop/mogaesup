import { defineGame } from '../game';
import type { Vec3 } from '../protocol';
import { TagOutcome, TagPanel } from './Panel';
import { TagWorld } from './World';

export type TagRole = 'it' | 'runner';

/** 술래잡기 as the server shows it (server/src/games/tag.rs). Times are on the server's clock. */
export type TagView = {
  /** The viewer's own; null for someone watching. */
  role: TagRole | null;
  /** The viewer's own start spot, during the head start only. */
  spot: Vec3 | null;
  /** User ids, in the order they joined. */
  its: string[];
  runners: string[];
  counts: { its: number; runners: number };
  /** Nobody is caught before this. */
  safeUntil: number;
  endsAt: number;
};

export type TagResult = {
  winner: 'runners' | 'its';
  /** The runners still free at the end. */
  runners: { id: string; name: string }[];
  /** Who started as it. */
  its: { id: string; name: string }[];
  /** In the order they were caught; `time` in ms since the start. */
  caught: { id: string; name: string; by: string; byName: string; time: number }[];
};

/** Infection tag: whoever an it reaches becomes an it (the server watches positions in the live room). */
export const tag = defineGame<TagView, TagResult>({
  kind: 'tag',
  label: '술래잡기',
  minPlayers: 3,
  maxPlayers: 30,
  // The server takes 12 to 200 open walkable spots and spreads the players over them.
  layout: ({ spots }) => ({ spots: spots() }),
  Panel: TagPanel,
  World: TagWorld,
  Result: TagOutcome,
});
