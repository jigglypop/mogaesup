import { defineGame } from '../game';
import type { Vec3 } from '../protocol';
import { findField, type BallView, type FieldView } from './field';
import { SoccerPanel, SoccerScore } from './Panel';
import { SoccerWorld } from './World';

export type Team = 'a' | 'b';

/** 축구 as the server shows it (server/src/games/soccer.rs). Each player sees only their own kickoff spot. */
export type SoccerView = {
  field: FieldView;
  ball: BallView;
  score: Record<Team, number>;
  /** Each team's players (user ids), in the order they joined. */
  teams: Record<Team, string[]>;
  /** The viewer's team; null for someone watching. */
  team: Team | null;
  phase: 'kickoff' | 'play';
  /** When play ends on the server's clock if nobody scores again: each kickoff stops the clock and moves it later. */
  endsAt: number;
  /** While the ball waits on the centre spot: which kickoff, until when, and where the viewer stands for it. */
  kickoff: { n: number; until: number; spot: Vec3 | null } | null;
};
export type SoccerResult = {
  score: Record<Team, number>;
  /** null for a draw. */
  winner: Team | null;
  /** Most goals first. */
  scorers: { id: string; name: string; team: Team; goals: number }[];
};

/** Two teams and one ball the server rolls, on a field laid over the host's open ground. */
export const soccer = defineGame<SoccerView, SoccerResult>({
  kind: 'soccer',
  label: '축구',
  minPlayers: 2,
  maxPlayers: 20,
  layout: ({ spots, position }) => findField(spots(), position),
  Panel: SoccerPanel,
  World: SoccerWorld,
  Result: SoccerScore,
});
