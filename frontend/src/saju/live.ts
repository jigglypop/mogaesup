import { useCallback, useEffect, useRef, useState } from 'react';

import { authApi } from '../api/endpoints';
import { noSeat } from '../games/useGameSession';
import { dogModelUrl } from './scene/dogModel';

// The 섬 as a place people are in together: everyone signed in who opens a home's page joins its room on the server
// (/api/rooms/{username}, the same rooms the islands used), as their own guardian dog. Where each stands and walks,
// and what each says, goes to the others; what they say shows over their head for a while.

/** What a walker is doing: standing, going (walking or running), or one of the moves played once. */
export type Action = 'idle' | 'walk' | 'run' | 'jump' | 'wave' | 'cheer' | 'dance';
const ACTIONS: readonly Action[] = ['idle', 'walk', 'run', 'jump', 'wave', 'cheer', 'dance'];

/** Someone in the room, as the page draws them: their dog, where they stand and face, and what they are doing. */
export type Walker = {
  id: string;
  name: string;
  dog: string;
  position: [number, number, number];
  /** Radians about the vertical: 0 faces +z. */
  facing: number;
  action: Action;
  /** Counts each move begun (a jump, a wave), so the same move twice is played twice. */
  moves: number;
};

/** A line in the room's talk: something said, or someone coming or going. */
export type Line = { key: number; kind: 'said' | 'came' | 'went'; name: string; text: string; own: boolean; at: number };
/** How many lines the talk keeps. */
const LOG = 60;

/** Something said, by whom, and when it stops showing. */
export type Said = { id: string; text: string; until: number };

/** How long a line said stays over its speaker's head, in milliseconds. */
const SAID_MS = 6000;
/** How far what is said carries, in metres (the server's own most): the whole of a home's island and its neighbours. */
const RANGE = 40;
/** How often a moving walker is sent, and a still one kept alive. */
const SEND_MS = 100;
const PING_MS = 15000;
const RETRY_MS = 4000;
const MAX_CHAT = 200;

const urlOf = (username: string, ticket: string) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${encodeURIComponent(username)}?ticket=${encodeURIComponent(ticket)}&once=true`;

/** How the server shuts the socket of a window whose account has come into the same room from another one. */
const ELSEWHERE = 4410;

/** The dog named in a model's address (`…/gltf/guardians/08.glb`), or a dog for one that names none. */
export function dogOfUrl(url: unknown): string {
  const found = typeof url === 'string' ? /\/gltf\/guardians\/(\d{2})\.glb$/.exec(url) : null;
  return found?.[1] ?? '02';
}

type State = { name?: string; position?: number[]; rotation?: number[]; animation?: string; modelUrl?: string };

/** The action an animation label carries (`jump:3`: the third move begun), and its count. */
function actionOf(label: string | undefined): { action: Action; moves: number } | null {
  if (!label) return null;
  const [name, count] = label.split(':');
  const action = ACTIONS.find((one) => one === name) ?? null;
  return action ? { action, moves: Number(count) || 0 } : null;
}

/** A quaternion (w, x, y, z) turned only about the vertical, back to its turn. */
const facingOf = (rotation: number[] | undefined) => (rotation && rotation.length === 4 ? 2 * Math.atan2(rotation[2]!, rotation[0]!) : 0);

function walkerOf(id: string, state: State, was?: Walker): Walker {
  const position = state.position && state.position.length === 3 ? (state.position as [number, number, number]) : (was?.position ?? [0, 0, 0]);
  return {
    id,
    name: state.name ?? was?.name ?? '',
    dog: state.modelUrl ? dogOfUrl(state.modelUrl) : (was?.dog ?? '02'),
    position,
    facing: state.rotation ? facingOf(state.rotation) : (was?.facing ?? 0),
    action: actionOf(state.animation)?.action ?? was?.action ?? 'idle',
    moves: actionOf(state.animation)?.moves ?? was?.moves ?? 0,
  };
}

export type VillageRoom = {
  /** Everyone else in the room, by their place in it; changed in place as they move (read it in a frame). */
  others: Map<string, Walker>;
  /** Who is in the room now, for what is drawn of them (changes as people come and go, not as they move). */
  present: string[];
  /** What is being said, the viewer's own included (under `self`). */
  said: Map<string, Said>;
  /** The talk so far, oldest first: what was said, and who came and went, since the viewer came in. */
  log: Line[];
  connected: boolean;
  refused: string | null;
  /** The viewer's account came into this room from another window, which now stands there in this one's place. */
  elsewhere: boolean;
  /** Comes back into the room from this window (the other one is let go). */
  rejoin: () => void;
  /** Tells the room where the viewer is and what they are doing (`moves` counts the moves begun). */
  move: (position: [number, number, number], facing: number, action: Action, moves: number) => void;
  say: (text: string) => boolean;
};

/** The viewer's own key in `said`. */
export const SELF = 'self';

/**
 * The room of `username`'s home for a viewer signed in as `viewerId`, walking as `dog` from `start`; nothing for a
 * visitor who is not signed in.
 */
export function useVillageRoom(username: string, viewerId: string | null, dog: string, start: [number, number, number]): VillageRoom {
  const others = useRef(new Map<string, Walker>()).current;
  const said = useRef(new Map<string, Said>()).current;
  const [present, setPresent] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [elsewhere, setElsewhere] = useState(false);
  const [joins, setJoins] = useState(0);
  const [, setTalk] = useState(0);
  const [log, setLog] = useState<Line[]>([]);
  const lineKey = useRef(0);
  const write = useCallback((line: Omit<Line, 'key' | 'at'>) => {
    lineKey.current += 1;
    const key = lineKey.current;
    setLog((lines) => [...lines.slice(-(LOG - 1)), { ...line, key, at: Date.now() }]);
  }, []);
  const socket = useRef<WebSocket | null>(null);
  const here = useRef({ position: start, facing: 0, action: 'idle' as Action, moves: 0, sentAt: 0, dirty: true });
  const startKey = start.join(',');

  useEffect(() => {
    if (!viewerId) return undefined;
    let stopped = false;
    let retry = 0;
    let ping = 0;
    let send = 0;
    here.current = { position: start, facing: 0, action: 'idle', moves: 0, sentAt: 0, dirty: true };
    setLog([]);
    setElsewhere(false);
    const roster = () => setPresent([...others.keys()]);
    const open = async () => {
      if (stopped) return;
      try {
        const { ticket, user } = await authApi.realtimeTicket();
        if (stopped || user.id !== viewerId) return;
        const ws = new WebSocket(urlOf(username, ticket));
        socket.current = ws;
        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ type: 'Join', room_id: username, color: '#f2c14e', modelUrl: `${location.origin}${dogModelUrl(dog)}` }));
          here.current.dirty = true;
          setConnected(true);
          setRefused(null);
        });
        ws.addEventListener('message', (event) => {
          let message: { type?: string; client_id?: string; state?: State; room_state?: unknown; text?: string };
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }
          const id = message.client_id;
          switch (message.type) {
            case 'Welcome': {
              others.clear();
              const room = message.room_state;
              const entries: [string, State][] = Array.isArray(room) ? (room as [string, State][]) : room && typeof room === 'object' ? (Object.entries(room) as [string, State][]) : [];
              for (const [peer, state] of entries) others.set(peer, walkerOf(peer, state));
              roster();
              break;
            }
            case 'PlayerJoined':
            case 'PlayerUpdate':
              if (!id || !message.state) break;
              {
                const was = others.get(id);
                const next = walkerOf(id, message.state, was);
                if (was) Object.assign(was, next);
                else {
                  others.set(id, next);
                  roster();
                  if (message.type === 'PlayerJoined') write({ kind: 'came', name: next.name, text: '', own: false });
                }
              }
              break;
            case 'PlayerLeft':
              if (id) {
                const gone = others.get(id);
                if (gone && others.delete(id)) {
                  said.delete(id);
                  roster();
                  write({ kind: 'went', name: gone.name, text: '', own: false });
                }
              }
              break;
            case 'Chat':
              if (id && typeof message.text === 'string') {
                said.set(id, { id, text: message.text, until: Date.now() + SAID_MS });
                setTalk((count) => count + 1);
                write({ kind: 'said', name: others.get(id)?.name ?? '', text: message.text, own: false });
              }
              break;
            default:
              break;
          }
        });
        ws.addEventListener('close', (event) => {
          if (socket.current === ws) socket.current = null;
          setConnected(false);
          others.clear();
          roster();
          // Another window of the account stands here now: this one waits to be asked back.
          if ((event as CloseEvent).code === ELSEWHERE) {
            setElsewhere(true);
            return;
          }
          const why = noSeat(event);
          if (why) setRefused(why);
          if (!stopped) retry = window.setTimeout(open, why ? 30000 : RETRY_MS);
        });
      } catch {
        if (!stopped) retry = window.setTimeout(open, RETRY_MS * 2);
      }
    };
    void open();
    // The viewer's place goes out as it changes, ten times a second at most, and now and then while it holds still.
    send = window.setInterval(() => {
      const ws = socket.current;
      const me = here.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (!me.dirty && now - me.sentAt < PING_MS) return;
      const half = me.facing / 2;
      ws.send(JSON.stringify({ type: 'Update', state: { position: me.position, rotation: [Math.cos(half), 0, Math.sin(half), 0], animation: `${me.action}:${me.moves}`, t: now } }));
      me.dirty = false;
      me.sentAt = now;
    }, SEND_MS);
    ping = window.setInterval(() => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Ping', ts: Date.now() }));
    }, PING_MS);
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      window.clearInterval(send);
      window.clearInterval(ping);
      const ws = socket.current;
      socket.current = null;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Leave' }));
      ws?.close();
      others.clear();
      said.clear();
      setConnected(false);
      setPresent([]);
    };
    // `start` is read once, when the room is joined (its key stands for it).
  }, [username, viewerId, dog, startKey, others, said, write, joins]);

  const rejoin = useCallback(() => setJoins((count) => count + 1), []);

  const move = useCallback((position: [number, number, number], facing: number, action: Action, moves: number) => {
    const me = here.current;
    if (action !== me.action || moves !== me.moves || action === 'walk' || action === 'run' || action === 'jump') me.dirty = true;
    me.position = position;
    me.facing = facing;
    me.action = action;
    me.moves = moves;
  }, []);

  const say = useCallback(
    (text: string) => {
      const line = text.trim().slice(0, MAX_CHAT);
      const ws = socket.current;
      if (!line || !ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify({ type: 'Chat', text: line, range: RANGE }));
      said.set(SELF, { id: SELF, text: line, until: Date.now() + SAID_MS });
      setTalk((count) => count + 1);
      write({ kind: 'said', name: '', text: line, own: true });
      return true;
    },
    [said, write],
  );

  return { others, present, said, log, connected, refused, elsewhere, rejoin, move, say };
}
