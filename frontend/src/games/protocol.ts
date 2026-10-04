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
  kind: string;
  phase: Phase;
  /** User id of the host: the first of `players`. */
  host: string;
  /** In the order they joined. */
  players: SessionPlayer[];
  /** The viewer's user id. */
  you: string;
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

export type ClientMessage =
  | { type: 'Open'; kind: string }
  | { type: 'Join' }
  | { type: 'Leave' }
  | { type: 'Start'; layout: unknown }
  | { type: 'Act'; action: unknown }
  | { type: 'Close' }
  | { type: 'Ping'; ts: number };

export type ServerMessage =
  | { type: 'Session'; session: GameSession | null }
  | { type: 'Event'; kind: string; event: unknown }
  | { type: 'Error'; code: string; message: string }
  | { type: 'Pong'; ts: number };

const PHASES: readonly string[] = ['lobby', 'playing', 'ended'];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

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
  return {
    kind,
    phase: phase as Phase,
    host,
    players: read as SessionPlayer[],
    you,
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
    default:
      return null;
  }
}
