import { defineGame } from '../game';
import type { Vec3 } from '../protocol';
import { oxLayout } from './layout';
import { OxPanel, OxRanking } from './Panel';
import { OxWorld } from './World';

export type OxZone = 'o' | 'x';
export type OxPerson = { id: string; name: string };
/** Someone out, and at which statement (from 1). */
export type OxOut = OxPerson & { round: number };

/** OX 퀴즈 as the server shows it (server/src/games/ox.rs). */
export type OxView = {
  /** The statement asked now, from 1, of `rounds`. */
  round: number;
  rounds: number;
  statement: string;
  /** `question` (문제) while everyone walks into a zone, `answer` (정답) while the answer shows. */
  phase: 'question' | 'answer';
  /** When this phase ends, on the server's clock. */
  endsAt: number;
  /** Only while the answer shows. */
  answer: OxZone | null;
  /** Who went out at this answer. */
  fallen: OxPerson[];
  survivors: OxPerson[];
  /** Latest first. */
  out: OxOut[];
  /** The viewer as a player (null when only watching): still in or out, and the zone they stand in now. */
  me: { state: 'in' | 'out'; zone: OxZone | null } | null;
  /** Each zone's spot on the ground, and how far it reaches. */
  zones: { o: Vec3; x: Vec3; radius: number };
};
/** The ones left in, then who went out, latest first. */
export type OxResult = { winners: OxPerson[]; out: OxOut[] };

/** Walk into O or X before time is up; the server judges where everyone stands. */
export const ox = defineGame<OxView, OxResult>({
  kind: 'ox',
  label: 'OX 퀴즈',
  minPlayers: 2,
  maxPlayers: 30,
  layout: ({ spots, position, building }) => oxLayout(spots(), position, building),
  Panel: OxPanel,
  World: OxWorld,
  Result: OxRanking,
});
