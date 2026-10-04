import { defineGame } from '../game';
import type { Vec3 } from '../protocol';
import { impostorLayout } from './layout';
import { ImpostorPanel, ImpostorResult } from './Panel';
import { ImpostorWorld } from './World';

export type ImpostorRole = 'crew' | 'impostor';

export type ImpostorMeeting = {
  number: number;
  stage: 'discuss' | 'vote';
  caller: string;
  callerName: string;
  reason: 'report' | 'emergency';
  /** Whose body was reported. */
  body: { victim: string; name: string } | null;
  /** When this stage ends, on the server's clock. */
  endsAt: number;
  /** Where the viewer sits at the table; null for the dead and onlookers. */
  seat: Vec3 | null;
  /** How many have voted (never for whom) and how many may. */
  voted: number;
  voters: number;
  /** The viewer's own vote once cast: a player, or null for 건너뛰기. */
  myVote: { target: string | null } | null;
};

export type ImpostorLine = { id: number; from: string; name: string; text: string; ghost: boolean };

/** 임포스터 as the server shows it to one viewer (server/src/games/impostor.rs): only their own secrets. */
export type ImpostorView = {
  phase: 'play' | 'discuss' | 'vote' | 'ended';
  /** The viewer's own role; null for onlookers. */
  role: ImpostorRole | null;
  /** Every impostor, to impostors only. */
  impostors: string[] | null;
  alive: boolean | null;
  /** The viewer's tasks by station (an impostor's are fake). */
  tasks: { station: number; done: boolean }[];
  working: { station: number; endsAt: number } | null;
  /** Over every crew task. */
  progress: { done: number; total: number };
  /** As everyone knows it (deaths turn public when a meeting ends); the dead see it as it is. */
  players: { id: string; name: string; alive: boolean }[];
  /** Who is dead now: their avatars are hidden from the living. */
  dead: string[];
  bodies: { id: number; victim: string; name: string; position: Vec3; reported: boolean }[];
  table: Vec3;
  stations: Vec3[];
  meeting: ImpostorMeeting | null;
  /** This meeting's lines; to the dead, the ghosts' too. */
  talk: ImpostorLine[];
  lastMeeting: {
    number: number;
    ejected: string | null;
    name: string | null;
    impostor: boolean | null;
    votes: { voter: string; target: string | null }[];
  } | null;
  /** To a living impostor: when they may kill next, and the crew in reach, nearest first. */
  kill: { readyAt: number; targets: string[] } | null;
  /** What the viewer's buttons reach now. */
  near: { station: number | null; body: number | null; table: boolean };
  emergencyLeft: number;
  /** When an emergency meeting may be called, on the server's clock. */
  emergencyFrom: number;
};

export type ImpostorOutcome = {
  winner: ImpostorRole;
  reason: 'tasks' | 'impostorsOut' | 'parity';
  players: { id: string; name: string; role: ImpostorRole; alive: boolean; left: boolean }[];
};

/** Among Us on the island: the crew do tasks at stations, impostors kill, and meetings at the table vote someone out. */
export const impostor = defineGame<ImpostorView, ImpostorOutcome>({
  kind: 'impostor',
  label: '임포스터',
  minPlayers: 4,
  maxPlayers: 15,
  layout: impostorLayout,
  Panel: ImpostorPanel,
  World: ImpostorWorld,
  Result: ImpostorResult,
});
