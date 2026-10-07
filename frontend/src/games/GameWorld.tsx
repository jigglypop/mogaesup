import { useEffect, useLayoutEffect, type RefObject } from 'react';

import type { RapierRigidBody } from '@react-three/rapier';

import { useActiveGame, useGameRoom, useGameStage, useGameState } from './room';
import type { GameClient } from './useGameSession';
import { standing, useTeleport } from './teleport';

/**
 * Lends the game client the world's way of moving the viewer's character (it needs the world's input and routes). Lent
 * as the canvas is laid out, before the game's `World` (mounted after it) looks where the viewer stands.
 */
function Teleporter({ client, playerRef }: { client: GameClient; playerRef: RefObject<RapierRigidBody> }) {
  const teleport = useTeleport(playerRef);
  useLayoutEffect(
    () => client.setTeleporter(teleport, () => standing(playerRef.current), () => playerRef.current),
    [client, teleport, playerRef],
  );
  return null;
}

/**
 * Brings the viewer home from a game's trip (see arena.tsx) once the island's game socket has shown them no game they
 * are in playing (one they play, or watch from its stand): its session closed, or went on without them, while its
 * `World` was not there to; and at once when they sign out, as no socket will say anything again.
 */
function TripHome({ client, signedIn }: { client: GameClient; signedIn: boolean }) {
  const { synced, session } = useGameState();
  const away = session?.phase === 'playing' && (session.players.some((player) => player.id === session.you) || !!session.stand);
  useEffect(() => {
    if (signedIn && (!synced || away)) return;
    const trip = client.trip();
    if (trip && client.teleport(trip.home)) client.setTrip(null);
  }, [synced, away, signedIn, client]);
  return null;
}

/**
 * The game being played (or just ended) inside the island's canvas: its `World`. A game whose map takes the island's
 * place draws it only while it has (not on the island of an owner decorating it, nor once it is over). Mount inside
 * the world.
 */
export function GameWorld({ playerRef }: { playerRef: RefObject<RapierRigidBody> }) {
  const room = useGameRoom();
  const active = useActiveGame();
  const stage = useGameStage();
  const World = active?.definition.World;
  const drawn = !!active && !!World && (!active.definition.replacesIsland || stage !== 'island');
  return (
    <>
      {room && <Teleporter client={room.client} playerRef={playerRef} />}
      {room && <TripHome client={room.client} signedIn={room.signedIn !== false} />}
      {drawn && <World key={active.definition.kind} {...active.props} />}
    </>
  );
}
