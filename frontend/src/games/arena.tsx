import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { Color, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';

import type { Box } from './arenaMap';
import type { GameProps } from './game';
import type { Vec3 } from './protocol';

/**
 * Arenas: maps of a game's own, built in the sky over the island (whose things stay where they are) with a floor to
 * stand on and walls; players are taken there as the game starts and back to where they stood when it is over.
 */

export { ARENA_Y, cellPoint, cells, floorBoxes, wallBoxes, type Box, type GridMap } from './arenaMap';

/** Fixed colliders for `boxes`, drawing nothing. Mount inside the world's physics (a game's `World` is). */
export function ArenaColliders({ boxes }: { boxes: readonly Box[] }) {
  return (
    <RigidBody type="fixed" colliders={false}>
      {boxes.map((box, index) => (
        <CuboidCollider key={index} args={[box.size[0] / 2, box.size[1] / 2, box.size[2] / 2]} position={box.center} />
      ))}
    </RigidBody>
  );
}

/** Markers and blocks are left out of picking, so a click on one walks to the ground under it. */
const noRaycast = () => null;

/** `boxes` drawn as one instanced mesh, each in its own colour (or `color`). */
export function ArenaBlocks({ boxes, color, colors, roughness = 0.8 }: { boxes: readonly Box[]; color?: string; colors?: readonly string[]; roughness?: number }) {
  const mesh = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const blocks = mesh.current;
    if (!blocks) return;
    const matrix = new Matrix4();
    const turn = new Quaternion();
    const tint = new Color();
    boxes.forEach((box, index) => {
      matrix.compose(new Vector3(...box.center), turn, new Vector3(...box.size));
      blocks.setMatrixAt(index, matrix);
      if (colors) blocks.setColorAt(index, tint.set(colors[index] ?? color ?? '#ffffff'));
    });
    blocks.instanceMatrix.needsUpdate = true;
    if (blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
    blocks.computeBoundingSphere();
  }, [boxes, color, colors]);
  return (
    <instancedMesh key={boxes.length} ref={mesh} args={[undefined, undefined, boxes.length]} raycast={noRaycast} receiveShadow castShadow>
      <boxGeometry />
      <meshStandardMaterial color={colors ? '#ffffff' : color} roughness={roughness} />
    </instancedMesh>
  );
}

/**
 * Takes the viewer to `entry` (a point on an arena's floor) once it is given, and back to where they stood before when
 * it is taken away (the game over, left, or closed). Mount in the game's `World`, which stays while the game is on;
 * `teleport` and `position` are its props.
 */
export function useArenaTrip(entry: Vec3 | null, { teleport, position }: Pick<GameProps, 'teleport' | 'position'>) {
  const home = useRef<Vec3 | null>(null);
  const key = entry?.join(',') ?? null;
  const target = useMemo(() => entry, [key]);
  useEffect(() => {
    if (!target) return;
    if (!home.current) home.current = position();
    teleport(target);
  }, [target, teleport, position]);
  useEffect(() => {
    if (target || !home.current) return;
    if (teleport(home.current)) home.current = null;
  }, [target, teleport]);
  // Closed or the page leaves the game: back home if there still is a world.
  const back = useRef(teleport);
  back.current = teleport;
  useEffect(
    () => () => {
      if (home.current) back.current(home.current);
    },
    [],
  );
}
