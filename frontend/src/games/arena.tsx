import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { Color, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';

import type { Box } from './arenaMap';
import type { GameProps } from './game';
import type { GameSession, Vec3 } from './protocol';

/**
 * Arenas: maps of a game's own that take the island's place while it plays (the island's scenery and colliders give
 * way, see `GameDefinition.replacesIsland`), built at its ground level with a floor to stand on and walls; players are
 * taken to their start as the game starts, whoever watches to its stand, and everyone back to where they stood when it
 * is over. The island's live room takes these jumps only because the game on the server sends them on them.
 */

export { cellPoint, cells, floorBoxes, MAP_Y, wallBoxes, type Box, type GridMap } from './arenaMap';

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
 * How far under its map's floor the viewer has fallen off it (over its edge into the sea, say): they are put back where
 * they last stood on it.
 */
export const FELL = 20;
/** How often the viewer's place on the map is kept, ms. */
const KEEP_EVERY = 250;
/** How far from a game's stand each watcher stands, at most, in meters: the server takes them within 2.5 m of it. */
const STAND_SPREAD = 1.5;

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Where the viewer watches a game from: the server's stand for them, spread a little by who they are, so that watchers
 * do not stand inside one another; null when they do not watch.
 */
export function standFor({ stand, you }: Pick<GameSession, 'stand' | 'you'>): Vec3 | null {
  if (!stand) return null;
  let hash = 2166136261;
  for (let index = 0; index < you.length; index += 1) hash = Math.imul(hash ^ you.charCodeAt(index), 16777619);
  const turn = ((hash >>> 0) / 2 ** 32) * Math.PI * 2;
  const reach = STAND_SPREAD * (0.35 + 0.65 * (((hash >>> 8) & 0xff) / 255));
  return [round(stand[0] + Math.cos(turn) * reach), stand[1], round(stand[2] + Math.sin(turn) * reach)];
}

/**
 * Takes the viewer to `entry` (a point on a map's floor: their start, or the stand they watch from) once a game (its
 * session and start), and back to where they stood before once it is taken away (the game over, or left): where the
 * server says (`session.home`), the only place it takes that jump to. A new `entry` from the same game (a player who
 * left it, to its stand) takes them there. The trip outlives the `World` it is mounted in: a game socket that drops
 * and comes back mounts it again, and finds the viewer where they are. The map lies where the island does, so nothing
 * about where the viewer stands says their canvas was set up anew: their body does, made anew at the island's start;
 * it is put back where they last stood on the map, as is one that fell off it. A session that closes meanwhile sends
 * them home from the island's `GameWorld`. The arguments past `entry` are the World's props.
 */
export function useArenaTrip(
  entry: Vec3 | null,
  { session, teleport, position, body, trip, setTrip }: Pick<GameProps, 'session' | 'teleport' | 'position' | 'body' | 'trip' | 'setTrip'>,
) {
  const game = `${session.id}:${session.startedAt ?? ''}`;
  const spot = entry?.join(',') ?? null;
  const target = useMemo(() => entry, [spot]);
  const home = session.home;
  // Looked at again with each update of the session, and a few times a second: a body that was not there yet may be.
  const seq = session.seq;
  const check = useCallback(() => {
    if (!target) return;
    const away = trip();
    const own = body();
    if (away?.key !== game) {
      // A game that starts before the last one brought them back keeps the first place they stood (so does the server).
      const from = home ?? away?.home ?? position();
      if (from && teleport(target)) setTrip({ key: game, home: from, at: target, to: spot ?? undefined, body: own });
      return;
    }
    if (away.to !== spot) {
      if (teleport(target)) setTrip({ ...away, at: target, to: spot ?? undefined, body: own });
      return;
    }
    const at = position();
    const anew = !!own && !!away.body && own !== away.body;
    if (anew || (at && at[1] < target[1] - FELL)) {
      if (teleport(away.at ?? target)) setTrip({ ...away, body: own });
      return;
    }
    if (at || (own && !away.body)) setTrip({ ...away, ...(at ? { at } : {}), body: away.body ?? own });
  }, [target, spot, game, home, teleport, position, body, trip, setTrip]);
  useLayoutEffect(check, [check, seq]);
  useEffect(() => {
    if (!target) return undefined;
    const keep = setInterval(check, KEEP_EVERY);
    return () => clearInterval(keep);
  }, [target, check]);
  useEffect(() => {
    const away = trip();
    if (target || !away) return;
    if (teleport(away.home)) setTrip(null);
  }, [target, teleport, trip, setTrip]);
}
