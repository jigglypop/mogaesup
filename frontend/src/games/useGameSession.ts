import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { RapierRigidBody } from '@react-three/rapier';

import { authApi } from '../api/endpoints';
import type { Trip } from './game';
import { readServerMessage, type ClientMessage, type GameEvent, type GameProblem, type GameSession, type Vec3 } from './protocol';
import { PET_REFUSALS, type PetFrame } from './protocol';
import { createServerClock } from './time';

const RETRY_FIRST_MS = 1_000;
const RETRY_LAST_MS = 30_000;

/**
 * The close code of a socket the server had no seat for (the island full, or too many sockets of this account, from
 * this place or on the server): its reason is a sentence for the page. The same for the live room's socket.
 */
export const NO_SEAT = 4409;
const NO_SEAT_TEXT = '지금은 들어갈 자리가 없어요.';

/** Why a socket that closed was refused a seat, for the page; null when it closed for anything else. */
export function noSeat(event: { code: number; reason?: string }): string | null {
  return event.code === NO_SEAT ? event.reason || NO_SEAT_TEXT : null;
}

/** The island's game socket: like the live room's, with the room's `client_id` for this page as `peer`. */
export const gameUrl = (username: string, ticket: string, peer: string | null) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/games/${encodeURIComponent(username)}` +
  `?ticket=${encodeURIComponent(ticket)}${peer ? `&peer=${encodeURIComponent(peer)}` : ''}`;

export type GameState = {
  /** The island's session as the server last showed it; null when it has none, or while the socket is down. */
  session: GameSession | null;
  connected: boolean;
  /** Whether this socket has shown the session yet: until it has, a null `session` says nothing. */
  synced: boolean;
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
  /** The trip a game has taken the viewer on, kept while the socket comes and goes; null when they are home. */
  trip: () => Trip | null;
  setTrip: (trip: Trip | null) => void;
  /** The island's world says how to teleport, where the character stands and which body is theirs; returns the way to
   * take it back. */
  setTeleporter: (
    teleport: (ground: Vec3) => boolean,
    locate?: () => Vec3 | null,
    body?: () => RapierRigidBody | null,
  ) => () => void;
  clearError: () => void;
  /** The island owner's page relays where its pet is (null lets go of it); false while the socket is down. */
  sendPet?: (pet: PetFrame | null) => boolean;
  /** Pet frames from the owner's page (null: the pet rests at home), and refusals of this page's own frames. */
  onPet?: (listener: (signal: PetSignal) => void) => () => void;
  /**
   * Opens a socket at `url` in place of any other; `closed` hears when it ends, whether a session came first, and
   * whether the server had no seat for it (its reason is then the state's `error`).
   */
  connect: (url: string, closed: (welcomed: boolean, refused: boolean) => void) => void;
  /** Closes the socket and forgets the session. */
  disconnect: () => void;
};

/** What the game socket says of the island's pet. */
export type PetSignal = { type: 'frame'; pet: PetFrame | null } | { type: 'refused'; code: string; message: string };

const same = (a: GameState, b: GameState) =>
  a.session === b.session && a.connected === b.connected && a.synced === b.synced && a.error === b.error;

export function createGameClient(): GameClient {
  let state: GameState = { session: null, connected: false, synced: false, error: null };
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(event: GameEvent) => void>();
  const petListeners = new Set<(signal: PetSignal) => void>();
  const tellPet = (signal: PetSignal) => {
    for (const listener of [...petListeners]) listener(signal);
  };
  let socket: WebSocket | null = null;
  const clock = createServerClock();
  let trip: Trip | null = null;
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
    serverNow: clock.now,
    trip: () => trip,
    setTrip(next) {
      trip = next;
    },
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
    // Several a second, apart from the game: it leaves the game's last refusal on screen.
    sendPet(pet) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ type: 'Pet', pet } satisfies ClientMessage));
      return true;
    },
    onPet(listener) {
      petListeners.add(listener);
      return () => petListeners.delete(listener);
    },
    connect(url, closed) {
      drop();
      set({ synced: false });
      const current = new WebSocket(url);
      socket = current;
      let welcomed = false;
      current.onopen = () => set({ connected: true });
      current.onmessage = (event: MessageEvent) => {
        const message = readServerMessage(event.data);
        if (!message) return;
        if (message.type === 'Session') {
          welcomed = true;
          if (message.session) clock.sample(message.session.now);
          set({ session: message.session, synced: true });
        } else if (message.type === 'Event') {
          for (const listener of [...eventListeners]) listener({ kind: message.kind, event: message.event });
        } else if (message.type === 'Pet') {
          tellPet({ type: 'frame', pet: message.pet });
        } else if (message.type === 'Error' && PET_REFUSALS.includes(message.code)) {
          tellPet({ type: 'refused', code: message.code, message: message.message });
        } else if (message.type === 'Error') {
          set({ error: { code: message.code, message: message.message } });
        }
      };
      current.onclose = (event: { code: number; reason?: string }) => {
        if (socket !== current) return;
        socket = null;
        // What the session is now is unknown until the next socket says; a refusal says why until the next message.
        const refused = noSeat(event);
        set({ connected: false, synced: false, session: null, ...(refused ? { error: { code: 'no_seat', message: refused } } : {}) });
        closed(welcomed, refused !== null);
      };
    },
    disconnect() {
      drop();
      set({ connected: false, synced: false, session: null, error: null });
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
 * minute), and the longest after one the server had no seat for. Turned off or unmounted, it closes the socket and
 * stops.
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
        // Another account signed in meanwhile: its own page connects.
        if (stopped || user.id !== viewerId) return;
        client.connect(gameUrl(username, ticket, peerRef.current), (welcomed, refused) => {
          if (welcomed) delay = RETRY_FIRST_MS;
          // No seat: not again for a while (each try takes a ticket).
          if (refused) delay = RETRY_LAST_MS;
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
