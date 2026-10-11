import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { RapierRigidBody } from '@react-three/rapier';

import { authApi } from '../api/endpoints';
import { doubtSession } from '../auth/sessionWork';
import { readServerMessage, type ClientMessage, type GameEvent, type GameProblem, type GameSession, type Vec3 } from './protocol';

const RETRY_FIRST_MS = 1_000;
const RETRY_LAST_MS = 30_000;
/** How the server shuts a socket on its viewer for good: their login ended (4401), the island closed to them (4403). */
const SHUT_OUT = new Set([4401, 4403]);
/**
 * How long the session stays as last shown while the socket is off. The server takes a player out of its game after ten
 * seconds out of the island's live room, and one shut out of the room may not hear the game socket's own word.
 */
const KEEP_OFF_MS = 15_000;

/** The island's game socket: like the live room's, with the room's `client_id` for this page as `peer`. */
export const gameUrl = (username: string, ticket: string, peer: string | null) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/games/${encodeURIComponent(username)}` +
  `?ticket=${encodeURIComponent(ticket)}${peer ? `&peer=${encodeURIComponent(peer)}` : ''}`;

export type GameState = {
  /**
   * The island's session as the server last showed it, kept while the socket is down (the game goes on without it);
   * null when it has none, or once the server has shut the socket on this viewer.
   */
  session: GameSession | null;
  connected: boolean;
  /** The server's last refusal, until the next message goes out. */
  error: GameProblem | null;
};

/** One page's game socket and what came over it. Methods keep their identity for the client's life. */
export type GameClient = {
  getState: () => GameState;
  subscribe: (listener: () => void) => () => void;
  /** Opens a lobby of `kind` (or, as its host, opens the session again as one). False while the socket is down. */
  open: (kind: string) => boolean;
  join: () => boolean;
  leave: () => boolean;
  /** The host starts the lobby's game with the game's `layout`. */
  start: (layout: unknown) => boolean;
  act: (action: unknown) => boolean;
  /** The host ends the session for everyone. */
  close: () => boolean;
  /** Every event the server sends (each with its game's kind); returns the way to stop listening. */
  onEvent: (listener: (event: GameEvent) => void) => () => void;
  /** The server's clock now, from the last session view. */
  serverNow: () => number;
  /** Moves the viewer's character (see teleport.ts) once the island's world has said how; false until then. */
  teleport: (ground: Vec3) => boolean;
  /** Where the viewer's character stands now, once the island's world has said how; null until then. */
  position: () => Vec3 | null;
  /** The viewer's own physics body, once the island's world has lent it; null until then. */
  body: () => RapierRigidBody | null;
  /** The island's world says how to teleport, where the character stands and which body is theirs; returns the way to
   * take it back. */
  setTeleporter: (
    teleport: (ground: Vec3) => boolean,
    locate?: () => Vec3 | null,
    body?: () => RapierRigidBody | null,
  ) => () => void;
  clearError: () => void;
  /** Opens a socket at `url` in place of any other; `closed` hears when it ends, and whether a session came first. */
  connect: (url: string, closed: (welcomed: boolean) => void) => void;
  /** Closes the socket; the session stays as last shown unless `forget` (it is no longer the viewer's). */
  disconnect: (forget?: boolean) => void;
};

const same = (a: GameState, b: GameState) => a.session === b.session && a.connected === b.connected && a.error === b.error;

export function createGameClient(): GameClient {
  let state: GameState = { session: null, connected: false, error: null };
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(event: GameEvent) => void>();
  let socket: WebSocket | null = null;
  let offset = 0;
  let teleporter: ((ground: Vec3) => boolean) | null = null;
  let locator: (() => Vec3 | null) | null = null;
  let own: (() => RapierRigidBody | null) | null = null;
  const set = (changes: Partial<GameState>) => {
    const next = { ...state, ...changes };
    if (same(next, state)) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const send = (message: ClientMessage) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    set({ error: null });
    return true;
  };
  const drop = () => {
    const current = socket;
    socket = null;
    if (!current) return;
    current.onopen = current.onmessage = current.onclose = current.onerror = null;
    if (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN) current.close(1000);
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: (kind) => send({ type: 'Open', kind }),
    join: () => send({ type: 'Join' }),
    leave: () => send({ type: 'Leave' }),
    start: (layout) => send({ type: 'Start', layout }),
    act: (action) => send({ type: 'Act', action }),
    close: () => send({ type: 'Close' }),
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    serverNow: () => Date.now() + offset,
    teleport: (ground) => teleporter?.(ground) ?? false,
    position: () => locator?.() ?? null,
    body: () => own?.() ?? null,
    setTeleporter(teleport, locate, body) {
      teleporter = teleport;
      locator = locate ?? null;
      own = body ?? null;
      return () => {
        if (teleporter === teleport) {
          teleporter = null;
          locator = null;
          own = null;
        }
      };
    },
    clearError: () => set({ error: null }),
    connect(url, closed) {
      drop();
      const current = new WebSocket(url);
      socket = current;
      let welcomed = false;
      current.onopen = () => set({ connected: true });
      current.onmessage = (event: MessageEvent) => {
        const message = readServerMessage(event.data);
        if (!message) return;
        if (message.type === 'Session') {
          welcomed = true;
          if (message.session) offset = message.session.now - Date.now();
          set({ session: message.session });
        } else if (message.type === 'Event') {
          for (const listener of [...eventListeners]) listener({ kind: message.kind, event: message.event });
        } else if (message.type === 'Error') {
          set({ error: { code: message.code, message: message.message } });
        }
      };
      current.onclose = (event: CloseEvent) => {
        if (socket !== current) return;
        socket = null;
        // A dropped socket leaves the session as last shown (what a game keeps hidden stays hidden, the viewer stays in
        // its arena, a folded panel stays folded) until the next socket says what it is now; one the server shut on
        // this viewer takes it away.
        set(SHUT_OUT.has(event.code) ? { connected: false, session: null } : { connected: false });
        closed(welcomed);
      };
    },
    disconnect(forget) {
      drop();
      set(forget ? { connected: false, session: null, error: null } : { connected: false, error: null });
    },
  };
}

export type GameSessionOptions = {
  /** The island's owner: the room key. */
  username: string;
  /** The signed-in viewer; nobody, no socket. */
  viewerId: string | null;
  /** The live room's `client_id` for this page; the server reads the player's position from it. */
  peer: string | null;
  /** Whether to hold a socket: signed in and in the island's live room. */
  enabled: boolean;
};

export type GameSessionApi = GameState &
  Pick<GameClient, 'open' | 'join' | 'leave' | 'start' | 'act' | 'close' | 'onEvent' | 'serverNow' | 'teleport' | 'position' | 'body'> & {
    client: GameClient;
  };

/**
 * The island page's game socket. While `enabled`, it asks for a realtime ticket and connects; when the socket drops it
 * connects again with a fresh ticket, waiting longer after each try that got no session (from a second up to half a
 * minute). Turned off or unmounted, it closes the socket and stops. The session stays as last shown while it is off for
 * a little while (the live room connecting again, say), and goes with the island or the account.
 */
export function useGameSession({ username, viewerId, peer, enabled }: GameSessionOptions): GameSessionApi {
  const [client] = useState(createGameClient);
  const state = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  const peerRef = useRef(peer);
  peerRef.current = peer;

  useEffect(() => {
    if (!enabled || !viewerId) return undefined;
    let stopped = false;
    let delay = RETRY_FIRST_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retry = () => {
      if (stopped) return;
      timer = setTimeout(() => void attempt(), delay);
      delay = Math.min(delay * 2, RETRY_LAST_MS);
    };
    const attempt = async () => {
      try {
        const { ticket, user } = await authApi.realtimeTicket();
        if (stopped) return;
        // Another account signed in meanwhile (in another tab): the app asks who is signed in, and its page connects.
        if (user.id !== viewerId) {
          doubtSession();
          return;
        }
        client.connect(gameUrl(username, ticket, peerRef.current), (welcomed) => {
          if (welcomed) delay = RETRY_FIRST_MS;
          retry();
        });
      } catch {
        // Signed out or rate limited; the next try waits longer.
        retry();
      }
    };
    void attempt();
    return () => {
      stopped = true;
      clearTimeout(timer);
      client.disconnect();
    };
  }, [client, username, viewerId, enabled]);
  // Another island or account starts with no session.
  useEffect(() => () => client.disconnect(true), [client, username, viewerId]);
  // Off for longer than the live room takes to come back: the session as last shown is no longer the viewer's.
  useEffect(() => {
    if (enabled && viewerId) return undefined;
    const timer = setTimeout(() => client.disconnect(true), KEEP_OFF_MS);
    return () => clearTimeout(timer);
  }, [client, enabled, viewerId]);

  return useMemo(
    () => ({
      ...state,
      client,
      open: client.open,
      join: client.join,
      leave: client.leave,
      start: client.start,
      act: client.act,
      close: client.close,
      onEvent: client.onEvent,
      serverNow: client.serverNow,
      teleport: client.teleport,
      position: client.position,
      body: client.body,
    }),
    [state, client],
  );
}
