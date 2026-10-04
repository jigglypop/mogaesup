import { defineGame } from '../game';
import type { Vec3 } from '../protocol';
import { TreasurePanel, TreasureRanking } from './Panel';
import { TreasureWorld } from './World';

/** 보물찾기 as the server shows it (server/src/games/treasure.rs). No secrets: every viewer sees the same. */
export type TreasureView = {
  gems: { id: number; position: Vec3; value: number }[];
  scores: { id: string; name: string; score: number }[];
  /** On the server's clock. */
  endsAt: number;
};
export type TreasureResult = { ranking: { id: string; name: string; score: number; rank: number }[] };

/** The reference game: walking up to a gem picks it up (the server watches positions in the live room). */
export const treasure = defineGame<TreasureView, TreasureResult>({
  kind: 'treasure',
  label: '보물찾기',
  minPlayers: 1,
  maxPlayers: 30,
  // The server takes 12 to 200 open walkable spots and lays the gems on them.
  layout: ({ spots }) => ({ spots: spots() }),
  Panel: TreasurePanel,
  World: TreasureWorld,
  Result: TreasureRanking,
});
