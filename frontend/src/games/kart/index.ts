import { defineGame } from '../game';
import type { Vec3 } from '../protocol';
import { kartLayout } from './layout';
import { KartLobby } from './Lobby';
import { KartOverlay } from './Overlay';
import { KartPanel, KartResult } from './Panel';
import { KartWorld } from './World';

export type KartItem = 'booster' | 'bubble';

/** Where a bot drives: along `points` from `departAt` (server clock) at `speed` m/s, then it stands at the last. */
export type KartRoute = { points: Vec3[]; departAt: number; speed: number };

/** A kart in the race, in the live order. */
export type KartRacer = {
  id: string;
  name: string;
  bot: boolean;
  /** Its colour: the crew palette's index. */
  color: number;
  /** Laps done. */
  lap: number;
  /** The gate it passes next. */
  next: number;
  /** When it finished, ms after the start. */
  finishedAt: number | null;
  rank: number;
  /** Server clock: until when a booster speeds it, and until when a bubble holds it. */
  boostUntil: number;
  trappedUntil: number;
};

/** 카트 as the server shows it to one viewer (server/src/games/kart/mod.rs). */
export type KartView = {
  phase: 'countdown' | 'race' | 'ended';
  startsAt: number;
  /** When the race closes: six minutes after the start, or 30 s after the first finish. */
  endsAt: number;
  laps: number;
  /** How many gates a lap has. */
  gates: number;
  racers: KartRacer[];
  /** The viewer's own progress and item; null for onlookers. */
  me: { lap: number; next: number; item: KartItem | null } | null;
  /** The viewer's grid slot. */
  spawn: Vec3 | null;
  boxes: { id: number; position: Vec3; ready: boolean }[];
  boosts: Vec3[];
  bots: { id: string; color: number; route: KartRoute }[];
};

export type KartOutcome = {
  ranking: { id: string; name: string; bot: boolean; rank: number; finishedAt: number | null; laps: number }[];
};

/** To the racer it concerns. */
export type KartEvent = { type: 'boost'; until: number } | { type: 'trapped'; until: number };

/** The host's lobby settings. */
export type KartOptions = { bots: number; laps: number };

/** KartRider in the sky over the island: laps of a fixed circuit, item boxes, boosters and water bubbles, and bots. */
export const kart = defineGame<KartView, KartOutcome>({
  kind: 'kart',
  label: '카트',
  minPlayers: 1,
  maxPlayers: 8,
  layout: kartLayout,
  Lobby: KartLobby,
  Panel: KartPanel,
  World: KartWorld,
  Overlay: KartOverlay,
  Result: KartResult,
});
