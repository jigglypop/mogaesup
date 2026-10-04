import { defineGame } from '../game';
import type { Vec3 } from '../protocol';
import { MAX_SPOTS, openSpots } from '../spots';
import { RedlightPanel, RedlightRanking } from './Panel';
import { findTrack, wallsOf } from './track';
import { RedlightWorld } from './World';

export type RedlightPhase = 'ready' | 'green' | 'red';
export type RedlightState = 'running' | 'finished' | 'out';

/** 무궁화 꽃이 피었습니다 as the server shows it (server/src/games/redlight.rs). Times are on the server's clock. */
export type RedlightView = {
  /** 준비, 초록불 or 빨간불. */
  phase: RedlightPhase;
  /** When this phase ends; in 준비, when the race begins. */
  phaseEndsAt: number;
  endsAt: number;
  track: { start: Vec3; finish: Vec3 };
  /** The viewer's own place on the start line, in 준비 only. */
  slot: Vec3 | null;
  /** The viewer's own; null for someone watching. */
  state: RedlightState | null;
  /** In the order they arrived; `time` in ms since the race began. */
  finished: { id: string; name: string; time: number }[];
  out: { id: string; name: string }[];
  counts: { running: number; finished: number; out: number };
};

export type RedlightResult = {
  /** Fastest first; the same time, the same rank. */
  finished: { id: string; name: string; time: number; rank: number }[];
  out: { id: string; name: string }[];
  /** Still running when the time ran out. */
  unfinished: { id: string; name: string }[];
};

/** Run on green, stand still on red: the server judges by where everyone stands in the live room. */
export const redlight = defineGame<RedlightView, RedlightResult>({
  kind: 'redlight',
  label: '무궁화 꽃이 피었습니다',
  minPlayers: 2,
  maxPlayers: 30,
  layout: ({ building, spots }) => {
    const candidates = spots();
    // Cut down to what a layout may carry, the spots leave out open cells between them: check lines against them all.
    const ground = candidates.length >= MAX_SPOTS ? openSpots(building, { limit: Infinity }) : candidates;
    return findTrack(candidates, { ground, walls: wallsOf(building) });
  },
  Panel: RedlightPanel,
  World: RedlightWorld,
  Result: RedlightRanking,
});
