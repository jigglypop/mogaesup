import { defineGame } from '../game';
import type { Vec3 } from '../protocol';
import { impostorLayout } from './layout';
import { ImpostorLobby } from './Lobby';
import { ImpostorOverlay } from './Overlay';
import { ImpostorPanel, ImpostorResult } from './Panel';
import { ImpostorWorld } from './World';

export type ImpostorRole = 'crew' | 'impostor';
/** What a station's task is: the page plays it (see tasks.tsx). */
export type TaskKind = 'wires' | 'swipe' | 'download' | 'numbers' | 'calibrate' | 'fuel';
export type SabotageKind = 'lights' | 'comms' | 'reactor';

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

/** Where a bot walks: along `points` from `departAt` (server clock) at `speed` m/s, then it stands at the last. */
export type BotRoute = { points: Vec3[]; departAt: number; speed: number };

/** A bot the game plays itself, as the viewer sees it. */
export type ImpostorBot = { id: string; name: string; color: number; route: BotRoute; ghost: boolean };

/** 임포스터 as the server shows it to one viewer (server/src/games/impostor/mod.rs): only their own secrets. */
export type ImpostorView = {
  phase: 'play' | 'discuss' | 'vote' | 'ended';
  /** The viewer's own role; null for onlookers. */
  role: ImpostorRole | null;
  /** Every impostor, to impostors only. */
  impostors: string[] | null;
  alive: boolean | null;
  /** Where the viewer starts, around the table. */
  spawn: Vec3 | null;
  /** The viewer's tasks by station (an impostor's are fake). */
  tasks: { station: number; done: boolean }[];
  /** The task underway: the page plays it and finishes it no sooner than `readyAt`. */
  working: { station: number; kind: TaskKind; readyAt: number } | null;
  /** Over every crew task; null to the crew while the comms are down. */
  progress: { done: number; total: number } | null;
  /** As everyone knows it (deaths turn public when a meeting starts); the dead see it as it is. */
  players: { id: string; name: string; alive: boolean; bot: boolean }[];
  /** People whose avatars the viewer does not see: the dead (to the living) and anyone in a vent. */
  hidden: string[];
  /** The bots the viewer sees: the living, and to the dead the ghosts too. */
  bots: ImpostorBot[];
  /** Where the dead lie; a bot's body keeps its colour. */
  bodies: { id: number; victim: string; color: number | null; name: string; position: Vec3; reported: boolean }[];
  table: Vec3;
  stations: Vec3[];
  stationKinds: TaskKind[];
  vents: Vec3[];
  /** The stations whose panels fix each sabotage. */
  panels: { lights: number; comms: number; reactor: [number, number] };
  /** What is broken: the reactor melts down at `endsAt` unless both its panels are held at once. */
  sabotage: { kind: SabotageKind; endsAt: number | null; held: [boolean, boolean] } | null;
  /** To impostors: when they may sabotage next. */
  sabotageFrom: number | null;
  /** The vent the viewer is in. */
  venting: number | null;
  meeting: ImpostorMeeting | null;
  /** This meeting's lines; to the dead, the ghosts' too. */
  talk: ImpostorLine[];
  lastMeeting: {
    number: number;
    ejected: string | null;
    name: string | null;
    impostor: boolean | null;
    /** Impostors left alive after it. */
    remaining: number;
    votes: { voter: string; target: string | null }[];
  } | null;
  /** To a living impostor: when they may kill next, and the crew in reach, nearest first. */
  kill: { readyAt: number; targets: string[] } | null;
  /** What the viewer's buttons reach now. */
  near: { station: number | null; body: number | null; table: boolean; vent: number | null; panel: boolean };
  emergencyLeft: number;
  /** When an emergency meeting may be called, on the server's clock. */
  emergencyFrom: number;
};

export type ImpostorOutcome = {
  winner: ImpostorRole;
  reason: 'tasks' | 'impostorsOut' | 'parity' | 'meltdown';
  players: { id: string; name: string; role: ImpostorRole; alive: boolean; left: boolean; bot: boolean }[];
};

/** Events the server sends to everyone (`killed` only to its victim). */
export type ImpostorEvent =
  | { type: 'killed' }
  | { type: 'meeting'; number: number; reason: 'report' | 'emergency'; caller: string; victim: string | null }
  | { type: 'verdict'; number: number; ejected: string | null; name: string | null; impostor: boolean | null }
  | { type: 'sabotage'; kind: SabotageKind }
  | { type: 'fixed'; kind: SabotageKind };

/** The host's lobby settings: bots to add, and (playing alone) their own side. */
export type ImpostorOptions = { bots: number; role: 'random' | ImpostorRole };

/** Among Us on the island: the crew do tasks at stations, impostors kill, vent and sabotage, and meetings at the table vote someone out. */
export const impostor = defineGame<ImpostorView, ImpostorOutcome>({
  kind: 'impostor',
  label: '임포스터',
  minPlayers: 1,
  maxPlayers: 15,
  layout: impostorLayout,
  Lobby: ImpostorLobby,
  Panel: ImpostorPanel,
  World: ImpostorWorld,
  Overlay: ImpostorOverlay,
  Result: ImpostorResult,
  // Each meeting brings the panel up once: the vote happens there.
  attention: (view) => (view.meeting && view.phase !== 'ended' ? `meeting-${view.meeting.number}` : null),
});
