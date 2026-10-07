/**
 * The game socket's messages (`GET /api/games/{username}?ticket=&peer=`), as `server/src/games/mod.rs` speaks them.
 * The live room's socket is gaesup-world's and carries none of this.
 */

/** A point on the island: x, y (height), z, in meters. */
export type Vec3 = [number, number, number];

export type Phase = 'lobby' | 'playing' | 'ended';

export type SessionPlayer = {
  /** User id. */
  id: string;
  name: string;
  /** Their live-room `client_id` (the key of their avatar in the room's players); null while they are out of the room. */
  peer: string | null;
};

/** The island's game session as the server shows it to this viewer. */
export type GameSession<View = unknown, Result = unknown> = {
  /** Tells this session from a later one on the island. */
  id: number;
  kind: string;
  phase: Phase;
  /** When its game started, on the server's clock; null before one has. */
  startedAt: number | null;
  /** Whether the viewer may close it: its host, and the island's owner. */
  canClose: boolean;
  /** User id of the host: the first of `players`. */
  host: string;
  /** In the order they joined. */
  players: SessionPlayer[];
  /** The viewer's user id. */
  you: string;
  /** Where the viewer stood in the live room when the game started (or before it took them to its stand): where a trip back lands. Null when the game took them nowhere (or a server from before said nothing of it). */
  home: Vec3 | null;
  /** Where the viewer watches from while a game whose map has taken the island's place plays and they do not play it; null otherwise. */
  stand: Vec3 | null;
  /** The game's own view for this viewer (only their own secrets); null in the lobby. */
  game: View | null;
  /** Once ended. */
  result: Result | null;
  /** Counts the updates the session has sent. */
  seq: number;
  /** The server's clock (ms) when this view was sent. */
  now: number;
};

/** Something a game announced, to everyone or to some players. */
export type GameEvent<Event = unknown> = { kind: string; event: Event };

/** Why the server refused a message: a stable code and a sentence for the page. */
export type GameProblem = { code: string; message: string };

/**
 * Where the island's pet is, as its owner's page relays it (`server/src/pets.rs` `relay_frame` checks the same):
 * `t` the owner page's clock in seconds, `ry` its turn about Y, `clip` what it loops (or walks with, while `move`),
 * `gesture` its last one-shot (played when `at` changes), `ball` where the ball is and whether it holds it.
 */
export type PetFrame = {
  id: string;
  t: number;
  at: Vec3;
  ry: number;
  move: boolean;
  speed: number;
  clip: PetFrameClip;
  gesture: { clip: PetFrameGesture; at: number } | null;
  ball: { at: Vec3; held: boolean } | null;
};
export const PET_FRAME_CLIPS = ['idle', 'walk', 'run', 'sit_hold', 'lie_hold', 'sit', 'lie'] as const;
export const PET_FRAME_GESTURES = ['bark', 'jump', 'sit', 'lie'] as const;
export type PetFrameClip = (typeof PET_FRAME_CLIPS)[number];
export type PetFrameGesture = (typeof PET_FRAME_GESTURES)[number];
/** Refusals of a pet frame: another of the owner's pages relays the pet, or the frame was not one. */
export const PET_REFUSALS: readonly string[] = ['pet_busy', 'bad_pet'];

export type ClientMessage =
  | { type: 'Open'; kind: string }
  | { type: 'Join' }
  | { type: 'Leave' }
  | { type: 'Start'; layout: unknown }
  | { type: 'Act'; action: unknown }
  | { type: 'Close' }
  | { type: 'Ping'; ts: number }
  | { type: 'Pet'; pet: PetFrame | null };

export type ServerMessage =
  | { type: 'Session'; session: GameSession | null }
  | { type: 'Event'; kind: string; event: unknown }
  | { type: 'Error'; code: string; message: string }
  | { type: 'Pong'; ts: number }
  | { type: 'Pet'; pet: PetFrame | null };

const PHASES: readonly string[] = ['lobby', 'playing', 'ended'];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `[x, y, z]` of finite numbers, or null. */
function readPoint(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((axis) => typeof axis === 'number' && Number.isFinite(axis))) return null;
  return [value[0], value[1], value[2]];
}

function readPlayer(value: unknown): SessionPlayer | null {
  if (!isObject(value) || typeof value['id'] !== 'string' || typeof value['name'] !== 'string') return null;
  const peer = value['peer'];
  return { id: value['id'], name: value['name'], peer: typeof peer === 'string' ? peer : null };
}

function readSession(value: unknown): GameSession | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const { kind, phase, host, players, you, seq, now } = value;
  if (typeof kind !== 'string' || typeof phase !== 'string' || !PHASES.includes(phase) || typeof host !== 'string') return undefined;
  if (typeof you !== 'string' || !Array.isArray(players) || typeof seq !== 'number' || typeof now !== 'number') return undefined;
  const read = players.map(readPlayer);
  if (read.some((player) => player === null)) return undefined;
  const { id, startedAt, canClose } = value;
  return {
    id: typeof id === 'number' ? id : 0,
    kind,
    phase: phase as Phase,
    startedAt: typeof startedAt === 'number' ? startedAt : null,
    canClose: canClose === true,
    host,
    players: read as SessionPlayer[],
    you,
    home: readPoint(value['home']),
    stand: readPoint(value['stand']),
    game: value['game'] ?? null,
    result: value['result'] ?? null,
    seq,
    now,
  };
}

/** A frame from the game socket, or null when it is not one this client knows. */
export function readServerMessage(raw: unknown): ServerMessage | null {
  let value: unknown;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  switch (value['type']) {
    case 'Session': {
      const session = readSession(value['session']);
      return session === undefined ? null : { type: 'Session', session };
    }
    case 'Event':
      return typeof value['kind'] === 'string' ? { type: 'Event', kind: value['kind'], event: value['event'] } : null;
    case 'Error':
      return typeof value['code'] === 'string' && typeof value['message'] === 'string'
        ? { type: 'Error', code: value['code'], message: value['message'] }
        : null;
    case 'Pong':
      return typeof value['ts'] === 'number' ? { type: 'Pong', ts: value['ts'] } : null;
    case 'Pet': {
      if (value['pet'] === null) return { type: 'Pet', pet: null };
      const pet = readPetFrame(value['pet']);
      return pet ? { type: 'Pet', pet } : null;
    }
    default:
      return null;
  }
}

const FRAME_REACH = 200;
const FRAME_DEPTH = 50;
const FRAME_HEIGHT = 300;
const FRAME_SPEED = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A point a relayed pet may stand at: on the island's ground reach, not far below or above it. */
function framePoint(value: unknown): Vec3 | null {
  const point = readPoint(value);
  if (!point) return null;
  const [x, y, z] = point;
  return Math.abs(x) <= FRAME_REACH && Math.abs(z) <= FRAME_REACH && y >= -FRAME_DEPTH && y <= FRAME_HEIGHT ? point : null;
}

/** A pet frame with each field checked as the server checks it (and nothing else kept), or null. */
export function readPetFrame(value: unknown): PetFrame | null {
  if (!isObject(value)) return null;
  const { id, t, ry, move, speed, clip, gesture, ball } = value;
  if (typeof id !== 'string' || !UUID.test(id) || !finite(t) || !finite(ry) || typeof move !== 'boolean') return null;
  if (!finite(speed) || speed < 0 || speed > FRAME_SPEED) return null;
  if (typeof clip !== 'string' || !(PET_FRAME_CLIPS as readonly string[]).includes(clip)) return null;
  const at = framePoint(value['at']);
  if (!at) return null;
  let readGesture: PetFrame['gesture'] = null;
  if (gesture !== null && gesture !== undefined) {
    if (!isObject(gesture) || typeof gesture['clip'] !== 'string' || !finite(gesture['at'])) return null;
    if (!(PET_FRAME_GESTURES as readonly string[]).includes(gesture['clip'])) return null;
    readGesture = { clip: gesture['clip'] as PetFrameGesture, at: gesture['at'] };
  }
  let readBall: PetFrame['ball'] = null;
  if (ball !== null && ball !== undefined) {
    const where = isObject(ball) ? framePoint(ball['at']) : null;
    if (!where || !isObject(ball) || typeof ball['held'] !== 'boolean') return null;
    readBall = { at: where, held: ball['held'] };
  }
  return { id, t, at, ry, move, speed, clip: clip as PetFrameClip, gesture: readGesture, ball: readBall };
}
