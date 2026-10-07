import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react';

import type { RapierRigidBody } from '@react-three/rapier';
import type { BuildingSerializedState } from 'gaesup-world/building';

import type { User } from '../api/types';
import { useLiveSelf } from '../minihome/live';
import type { GameDefinition, GameProps } from './game';
import type { GameSession } from './protocol';
import { gameOf } from './registry';
import { useGameSession, type GameClient, type GameState } from './useGameSession';

/** What the island's game pieces share. Its identity changes only with `live`, so the canvas (which R3F bridges this into) is not drawn again for every game update. */
export type GameRoomValue = {
  client: GameClient;
  /** Whether the signed-in viewer is in the island's live room; the dock shows only then. */
  live: boolean;
  /** The island as this page has it loaded, for the host's layout. */
  building: () => BuildingSerializedState;
  /** The viewer's character. */
  playerRef: RefObject<RapierRigidBody | null>;
  /** The owner decorating: the island stays itself whatever game plays on it. */
  decorating?: boolean;
  /** Whether someone is signed in on this page: signed out, no game socket comes back, and nobody is left on a game's map. */
  signedIn?: boolean;
};

export const GameContext = createContext<GameRoomValue | null>(null);

type GameRoomProps = {
  username: string;
  viewer: User | null;
  building: () => BuildingSerializedState;
  playerRef: RefObject<RapierRigidBody | null>;
  decorating?: boolean;
  children: ReactNode;
};

/** The island's game socket for everything below it; render it inside the live room, whose `client_id` it plays by. */
export function GameRoom({ username, viewer, building, playerRef, decorating = false, children }: GameRoomProps) {
  const self = useLiveSelf();
  const live = !!viewer && self.connected && !!self.peer;
  const { client } = useGameSession({ username, viewerId: viewer?.id ?? null, peer: self.peer, enabled: live });
  const signedIn = !!viewer;
  const value = useMemo(
    () => ({ client, live, building, playerRef, decorating, signedIn }),
    [client, live, building, playerRef, decorating, signedIn],
  );
  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export const useGameRoom = () => useContext(GameContext);

const OUTSIDE: GameState = { session: null, connected: false, synced: false, error: null };
const outside = () => OUTSIDE;
const unsubscribed = () => () => {};

/**
 * What the island is for the viewer now: itself, or the map of a game playing on it that has taken its place, which
 * they watch, play on foot, or drive (the game moves their body).
 */
export type GameStage = 'island' | 'watch' | 'play' | 'drive';

export function stageOf(session: GameSession | null | undefined, decorating = false): GameStage {
  const definition = gameOf(session?.kind);
  if (decorating || !session || session.phase !== 'playing' || !definition?.replacesIsland) return 'island';
  if (!session.players.some((player) => player.id === session.you)) return 'watch';
  return definition.controlsPlayer ? 'drive' : 'play';
}

/** The stage each client last showed with a session it knew. */
const kept = new WeakMap<GameClient, GameStage>();

/**
 * The viewer's stage now. Between game sockets (one dropped and the next has said nothing yet) it stays what it was
 * while the viewer is still away on a game's trip: the map stays under their feet, and the island does not come back
 * for a moment only to go again.
 */
export function stageNow(client: GameClient | undefined, decorating = false, signedIn = true): GameStage {
  if (!client || !signedIn) return 'island';
  const { session, synced } = client.getState();
  let stage: GameStage;
  if (synced) {
    stage = stageOf(session);
    kept.set(client, stage);
  } else {
    stage = client.trip() ? (kept.get(client) ?? 'island') : 'island';
  }
  return decorating ? 'island' : stage;
}

/** The viewer's stage, re-rendering only when it changes (not with every update of the game). */
export function useGameStage(): GameStage {
  const room = useGameRoom();
  const client = room?.client;
  const decorating = !!room?.decorating;
  const signedIn = room?.signedIn !== false;
  const stage = useCallback(() => stageNow(client, decorating, signedIn), [client, decorating, signedIn]);
  return useSyncExternalStore(client?.subscribe ?? unsubscribed, stage, stage);
}

/** The island's game state, re-rendering as it changes. */
export function useGameState(): GameState {
  const client = useGameRoom()?.client;
  return useSyncExternalStore(client?.subscribe ?? unsubscribed, client?.getState ?? outside, client?.getState ?? outside);
}

export type ActiveGame = { definition: GameDefinition; props: GameProps; result: unknown };

/**
 * The game being played or just ended, with what its components get; null in the lobby or without one. Between game
 * sockets, the game the viewer is away in stays as it was last shown (its map under their feet, the kart they drive)
 * until the next socket says what it is now.
 */
export function useActiveGame(): ActiveGame | null {
  const client = useGameRoom()?.client;
  const { session, synced } = useGameState();
  const shown = useShownGame(client, session);
  const last = useRef<ActiveGame | null>(null);
  if (synced || !client?.trip()) last.current = shown;
  return synced ? shown : (last.current ?? shown);
}

function useShownGame(client: GameClient | undefined, session: GameSession | null): ActiveGame | null {
  const kind = session?.kind;
  const onEvent = useCallback(
    (listener: (event: unknown) => void) =>
      client?.onEvent((event) => {
        if (event.kind === kind) listener(event.event);
      }) ?? (() => {}),
    [client, kind],
  );
  return useMemo(() => {
    const definition = gameOf(kind);
    if (!client || !session || !definition || session.game === null) return null;
    const me = session.players.find((player) => player.id === session.you) ?? null;
    const props: GameProps = {
      session,
      view: session.game,
      me,
      act: client.act,
      onEvent,
      serverNow: client.serverNow,
      teleport: client.teleport,
      position: client.position,
      body: client.body,
      trip: client.trip,
      setTrip: client.setTrip,
    };
    return { definition, props, result: session.result };
  }, [client, session, kind, onEvent]);
}
