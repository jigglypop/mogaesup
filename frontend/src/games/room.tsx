import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode, type RefObject } from 'react';

import type { RapierRigidBody } from '@react-three/rapier';
import type { BuildingSerializedState } from 'gaesup-world/building';

import type { User } from '../api/types';
import { useLiveSelf } from '../minihome/live';
import type { GameDefinition, GameProps } from './game';
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
};

export const GameContext = createContext<GameRoomValue | null>(null);

type GameRoomProps = {
  username: string;
  viewer: User | null;
  building: () => BuildingSerializedState;
  playerRef: RefObject<RapierRigidBody | null>;
  children: ReactNode;
};

/** The island's game socket for everything below it; render it inside the live room, whose `client_id` it plays by. */
export function GameRoom({ username, viewer, building, playerRef, children }: GameRoomProps) {
  const self = useLiveSelf();
  const live = !!viewer && self.connected && !!self.peer;
  const { client } = useGameSession({ username, viewerId: viewer?.id ?? null, peer: self.peer, enabled: live });
  const value = useMemo(() => ({ client, live, building, playerRef }), [client, live, building, playerRef]);
  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export const useGameRoom = () => useContext(GameContext);

const OUTSIDE: GameState = { session: null, connected: false, error: null };
const outside = () => OUTSIDE;
const unsubscribed = () => () => {};

/** The island's game state, re-rendering as it changes. */
export function useGameState(): GameState {
  const client = useGameRoom()?.client;
  return useSyncExternalStore(client?.subscribe ?? unsubscribed, client?.getState ?? outside, client?.getState ?? outside);
}

export type ActiveGame = { definition: GameDefinition; props: GameProps; result: unknown };

/** The game being played or just ended, with what its components get; null in the lobby or without one. */
export function useActiveGame(): ActiveGame | null {
  const client = useGameRoom()?.client;
  const { session } = useGameState();
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
    };
    return { definition, props, result: session.result };
  }, [client, session, kind, onEvent]);
}
