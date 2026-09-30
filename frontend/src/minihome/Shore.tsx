import { useMemo } from 'react';

import { CuboidCollider, RigidBody } from '@react-three/rapier';

import { useBuildingStore } from 'gaesup-world/building';

import { SEABED, shoreWalls } from './coast';

/** Keeps walkers on the island: invisible walls where it meets the sea, and a floor under the sea. */
export function Shore() {
  const tileGroups = useBuildingStore((state) => state.tileGroups);
  const walls = useMemo(() => shoreWalls([...tileGroups.values()].flatMap((group) => group.tiles)), [tileGroups]);
  return (
    <RigidBody type="fixed" colliders={false}>
      <CuboidCollider args={SEABED.halfExtents} position={SEABED.position} />
      {walls.map((wall) => (
        <CuboidCollider key={wall.position.join(',')} args={wall.halfExtents} position={wall.position} />
      ))}
    </RigidBody>
  );
}
