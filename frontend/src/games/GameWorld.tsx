import { useEffect, type RefObject } from 'react';

import type { RapierRigidBody } from '@react-three/rapier';

import { useActiveGame, useGameRoom } from './room';
import type { GameClient } from './useGameSession';
import { useTeleport } from './teleport';

/** Lends the game client the world's way of moving the viewer's character (it needs the world's input and routes). */
function Teleporter({ client, playerRef }: { client: GameClient; playerRef: RefObject<RapierRigidBody> }) {
  const teleport = useTeleport(playerRef);
  useEffect(() => client.setTeleporter(teleport), [client, teleport]);
  return null;
}

/** The game being played (or just ended) inside the island's canvas: its `World` markers. Mount inside the world. */
export function GameWorld({ playerRef }: { playerRef: RefObject<RapierRigidBody> }) {
  const room = useGameRoom();
  const active = useActiveGame();
  const World = active?.definition.World;
  return (
    <>
      {room && <Teleporter client={room.client} playerRef={playerRef} />}
      {active && World && <World key={active.definition.kind} {...active.props} />}
    </>
  );
}
