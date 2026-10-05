import { vi } from 'vitest';

import type { GameProps } from '../game';
import type { ImpostorView } from '../impostor';
import type { GameSession, SessionPlayer } from '../protocol';

/** A 임포스터 view and the props its components get, for the panel's and the overlay's tests. */
export const NOW = 7_000_000;
export const me: SessionPlayer = { id: 'me', name: '나', peer: 'peer-me' };
export const players: SessionPlayer[] = [me, { id: 'b', name: '비', peer: 'peer-b' }, { id: 'c', name: '씨', peer: 'peer-c' }, { id: 'd', name: '디', peer: 'peer-d' }];

export const game = (changes: Partial<ImpostorView> = {}): ImpostorView => ({
  phase: 'play',
  role: 'crew',
  impostors: null,
  alive: true,
  spawn: [1.6, 0, 0],
  tasks: [{ station: 2, done: true }, { station: 5, done: false }, { station: 0, done: false }, { station: 7, done: false }],
  working: null,
  progress: { done: 3, total: 12 },
  players: players.map(({ id, name }) => ({ id, name, alive: true, bot: false })),
  hidden: [],
  bots: [],
  bodies: [],
  table: [0, 0, 0],
  stations: Array.from({ length: 8 }, (_, index) => [index * 8, 0, 20]),
  stationKinds: ['wires', 'swipe', 'download', 'numbers', 'calibrate', 'fuel', 'wires', 'swipe'],
  vents: [[0, 0, -20], [20, 0, -20]],
  panels: { lights: 1, comms: 3, reactor: [0, 7] },
  sabotage: null,
  sabotageFrom: null,
  venting: null,
  meeting: null,
  talk: [],
  lastMeeting: null,
  kill: null,
  near: { station: null, body: null, table: false, vent: null, panel: false },
  emergencyLeft: 1,
  emergencyFrom: NOW - 1,
  ...changes,
});

export function props(shown: ImpostorView, you = me.id) {
  const session: GameSession<ImpostorView> = { kind: 'impostor', phase: 'playing', host: me.id, players, you, game: shown, result: null, seq: 1, now: NOW };
  return {
    session,
    view: shown,
    me: players.find((player) => player.id === you) ?? null,
    act: vi.fn((_action: unknown) => true),
    onEvent: (_listener: (event: unknown) => void) => () => {},
    serverNow: () => NOW,
    teleport: vi.fn(() => true),
    position: () => null,
    body: () => null,
  } satisfies GameProps<ImpostorView>;
}

