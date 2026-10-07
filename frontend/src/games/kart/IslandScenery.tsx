import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { Color, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';

import { ArenaBlocks, ArenaColliders, type Box } from '../arena';
import type { Vec3 } from '../protocol';
import { band, blocksAlong, fan, mergeStraight, roundedOutline } from './shapes';
import { frame, HALF_WIDTH, MIDDLE, nearest, STAND, START, TRACK_Y, type Flat } from './track';

/**
 * 카트's racing island, drawn in the island's place while a race runs: grass round the whole circuit, a beach and the
 * shallows, the sea out to the horizon, groves clear of the road and the stand, and a gantry over the start. Its floor
 * and an unseen wall along the water's edge are colliders, so whoever walks it (someone watching) stays on it.
 */

/** Markers are left out of picking, so a click on one walks to the ground under it. */
const noRaycast = () => null;
/** Left out of the camera's collision: the chase camera rides over the island. */
const PASS = { intangible: true };

/** Grass beyond the circuit's extent, the beach past it, the shallows past that, and how round the corners are, in meters. */
const MARGIN = 26;
const BEACH = 10;
const SHALLOWS = 26;
const CORNER = 34;
/** How far a tree stands from the road's middle, the start and the stand, at least. */
const CLEAR_ROAD = 16;
const CLEAR_START = 34;
const CLEAR_STAND = 14;
/** How high the gantry's beam is over the road. */
const GANTRY = 6.6;

export type SceneryColors = {
  ground: string;
  sand: string;
  shallow: string;
  sea: string;
  tree: string;
  trunk: string;
  gantry: string;
  line: string;
  checker: string;
};

const EXTENT = (() => {
  const xs = MIDDLE.map((point) => point[0]);
  const zs = MIDDLE.map((point) => point[1]);
  const min: Flat = [Math.min(...xs) - HALF_WIDTH, Math.min(...zs) - HALF_WIDTH];
  const max: Flat = [Math.max(...xs) + HALF_WIDTH, Math.max(...zs) + HALF_WIDTH];
  return { min, max };
})();
/** The circuit's extent grown `by` meters on every side. */
const grown = (by: number): [Flat, Flat] => [
  [EXTENT.min[0] - by, EXTENT.min[1] - by],
  [EXTENT.max[0] + by, EXTENT.max[1] + by],
];
/** The grass's edge, the water line and the shallows' outer edge: as many points each. */
const LAND = roundedOutline(...grown(MARGIN), CORNER, 10);
const SHORE = roundedOutline(...grown(MARGIN + BEACH), CORNER + BEACH, 10);
const REEF = roundedOutline(...grown(MARGIN + BEACH + SHALLOWS), CORNER + BEACH + SHALLOWS, 10);

/** Whether `point` lies on the grass, `inset` meters in from its edge at least. */
function onLand([x, z]: Flat, inset: number): boolean {
  const [min, max] = grown(MARGIN - inset);
  const radius = CORNER - inset;
  const cx = Math.min(Math.max(x, min[0] + radius), max[0] - radius);
  const cz = Math.min(Math.max(z, min[1] + radius), max[1] - radius);
  return x >= min[0] && x <= max[0] && z >= min[1] && z <= max[1] && Math.hypot(x - cx, z - cz) <= radius;
}

type Tree = { at: Flat; scale: number; turn: number };

/** The groves: a jittered grid over the grass, clear of the road, the start and the stand. */
export const TREES: readonly Tree[] = (() => {
  const trees: Tree[] = [];
  const [min, max] = grown(MARGIN);
  for (let x = min[0]; x <= max[0]; x += 15) {
    for (let z = min[1]; z <= max[1]; z += 15) {
      const at: Flat = [x + Math.sin(z * 3.1 + x) * 5, z + Math.cos(x * 2.3 - z) * 5];
      if (!onLand(at, 6)) continue;
      const road = MIDDLE[nearest(at)]!;
      if (Math.hypot(at[0] - road[0], at[1] - road[1]) < CLEAR_ROAD) continue;
      if (Math.hypot(at[0] - START[0], at[1] - START[1]) < CLEAR_START) continue;
      if (Math.hypot(at[0] - STAND[0], at[1] - STAND[1]) < CLEAR_STAND) continue;
      trees.push({ at, scale: 0.8 + (Math.sin(x * 7 + z * 3) + 1) * 0.3, turn: Math.abs(x * 13 + z * 7) % (Math.PI * 2) });
    }
  }
  return trees;
})();

/** A whole grove in three draw calls (trunks, crowns and their tips), with no physics or frame callbacks. */
function Grove({ colors }: { colors: SceneryColors }) {
  const trunks = useRef<InstancedMesh>(null);
  const crowns = useRef<InstancedMesh>(null);
  const tips = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const matrix = new Matrix4();
    const turn = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const tint = new Color();
    const parts = [
      [trunks, 1.2, 0.42, 2.4, null],
      [crowns, 3.6, 3.4, 4.6, colors.tree],
      [tips, 5.9, 2.5, 3.8, colors.tree],
    ] as const;
    for (const [ref, height, width, tall, color] of parts) {
      const mesh = ref.current;
      if (!mesh) continue;
      TREES.forEach(({ at, scale, turn: yaw }, index) => {
        matrix.compose(new Vector3(at[0], TRACK_Y + height * scale, at[1]), turn.setFromAxisAngle(up, yaw), new Vector3(width * scale, tall * scale, width * scale));
        mesh.setMatrixAt(index, matrix);
        if (color) mesh.setColorAt(index, tint.set(color).multiplyScalar(0.84 + (index % 5) * 0.05));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }, [colors]);
  return (
    <group userData={PASS}>
      <instancedMesh ref={trunks} args={[undefined, undefined, TREES.length]} raycast={noRaycast} castShadow>
        <cylinderGeometry args={[0.7, 1, 1, 7]} />
        <meshStandardMaterial color={colors.trunk} roughness={1} />
      </instancedMesh>
      {[crowns, tips].map((ref, index) => (
        <instancedMesh key={index} ref={ref} args={[undefined, undefined, TREES.length]} raycast={noRaycast} castShadow receiveShadow>
          <coneGeometry args={[1, 1, 8]} />
          <meshStandardMaterial color="#ffffff" roughness={0.95} flatShading />
        </instancedMesh>
      ))}
    </group>
  );
}

/** The start's gantry: two posts outside the barriers and a beam over the line, a checkered banner on both its faces. */
function gantry(): { frame: Box[]; squares: Box[]; dark: boolean[] } {
  const { ahead, across } = frame(MIDDLE, 0);
  const at = (side: number, along: number, y: number): Vec3 => [START[0] + across[0] * side + ahead[0] * along, y, START[1] + across[1] * side + ahead[1] * along];
  const reach = HALF_WIDTH + 3;
  // The road runs along x at the start: the posts and the beam stand square to it, the beam across it (along z).
  const posts: Box[] = [-1, 1].map((side) => ({ center: at(side * reach, 0, TRACK_Y + GANTRY / 2), size: [0.7, GANTRY, 0.7] }));
  const beam: Box = { center: at(0, 0, TRACK_Y + GANTRY), size: [0.9, 1.5, reach * 2 + 0.7] };
  const squares: Box[] = [];
  const dark: boolean[] = [];
  const count = 14;
  const width = (reach * 2) / count;
  for (const face of [-1, 1]) {
    for (let column = 0; column < count; column++) {
      for (let row = 0; row < 2; row++) {
        squares.push({ center: at((column - (count - 1) / 2) * width, face * 0.47, TRACK_Y + GANTRY - 0.36 + row * 0.72), size: [0.02, 0.72, width] });
        dark.push((column + row) % 2 === 0);
      }
    }
  }
  return { frame: [...posts, beam], squares, dark };
}

/** The land and its colliders: the grass, the beach sloping into the shallows, the sea, the groves and the gantry. */
export const IslandScenery = memo(function IslandScenery({ colors }: { colors: SceneryColors }) {
  const parts = useMemo(() => {
    const [min, max] = grown(MARGIN + BEACH);
    const floor: Box = { center: [(min[0] + max[0]) / 2, TRACK_Y - 0.5, (min[1] + max[1]) / 2], size: [max[0] - min[0], 1, max[1] - min[1]] };
    // An unseen wall along the water line, all the way round.
    const walls = mergeStraight(blocksAlong(SHORE, 0, 1, [0.6, 3.2], TRACK_Y + 1.6, 0.2));
    const { frame: posts, squares, dark } = gantry();
    return {
      grass: fan(LAND, TRACK_Y),
      sand: band(LAND, SHORE, TRACK_Y, TRACK_Y - 0.12),
      shallows: band(SHORE, REEF, TRACK_Y - 0.12, TRACK_Y - 0.75),
      floor,
      walls,
      posts,
      squares,
      tints: dark.map((on) => (on ? colors.checker : colors.line)),
    };
  }, [colors]);
  useEffect(
    () => () => {
      parts.grass.dispose();
      parts.sand.dispose();
      parts.shallows.dispose();
    },
    [parts],
  );
  return (
    <group userData={PASS} name="kart-island">
      <ArenaColliders boxes={[parts.floor]} />
      <RigidBody type="fixed" colliders={false}>
        {parts.walls.map((wall, index) => (
          <CuboidCollider key={index} args={[wall.size[0] / 2, wall.size[1] / 2, wall.size[2] / 2]} position={wall.center} rotation={[0, wall.yaw, 0]} />
        ))}
      </RigidBody>
      <mesh geometry={parts.grass} raycast={noRaycast} receiveShadow>
        <meshStandardMaterial color={colors.ground} roughness={1} />
      </mesh>
      <mesh geometry={parts.sand} raycast={noRaycast} receiveShadow>
        <meshStandardMaterial color={colors.sand} roughness={1} />
      </mesh>
      <mesh geometry={parts.shallows} raycast={noRaycast}>
        <meshStandardMaterial color={colors.shallow} roughness={0.35} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, TRACK_Y - 0.6, 0]} raycast={noRaycast}>
        <planeGeometry args={[2400, 2400]} />
        <meshStandardMaterial color={colors.sea} roughness={0.3} metalness={0.05} />
      </mesh>
      <Grove colors={colors} />
      <ArenaBlocks boxes={parts.posts} color={colors.gantry} roughness={0.6} />
      <ArenaBlocks boxes={parts.squares} colors={parts.tints} roughness={0.7} />
    </group>
  );
});
