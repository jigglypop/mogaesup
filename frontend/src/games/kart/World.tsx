import { memo, useEffect, useMemo, useRef, type RefObject } from 'react';

import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { BufferAttribute, BufferGeometry, Color, Matrix4, Quaternion, Vector3, type Group, type InstancedMesh, type Mesh } from 'three';

import { AFTER_MOTION_FRAME_ORDER, useEngineFrame, useGaesupStoreApi, useInteractionSystem, useStateSystem, type CameraOption, type CameraType } from 'gaesup-world';
import { useClickNavigationRoute } from 'gaesup-world/navigation';

import { useLivePlayers } from '../../minihome/live';
import { ARENA_Y, ArenaBlocks, ArenaColliders, useArenaTrip, type Box } from '../arena';
import type { GameProps } from '../game';
import type { Vec3 } from '../protocol';
import type { KartRacer, KartView } from './index';
import { afterContact, isKartKey, KART_KEYS, kartVelocity, readKeys, startKart, stepKart } from './physics';
import { routeAt } from './route';
import { frame, HALF_WIDTH, headingOf, MIDDLE, nearest, offsetLine, START, START_HEADING, type Flat } from './track';

/** Markers are left out of picking, so a click on one walks to the ground under it. */
const noRaycast = () => null;
/** Left out of the camera's collision: the chase camera rides over the track, and karts and boxes pass under it. */
const PASS = { intangible: true };
/** Names over the bots stay under the page's panels. */
const NAME_LAYERS: [number, number] = [12, 0];
const CREW_COLORS = 12;
/** The camera behind the kart while it races. */
const CHASE: CameraOption = { xDistance: 14, yDistance: 8, zDistance: 14, fov: 52, zoom: 1, smoothing: { position: 0.25, rotation: 0.2, fov: 0.1 } };
/** A boost pad's reach and how long it pushes, ms. */
const PAD_REACH = 3;
const PAD_TIME = 1_200;
/** Below the track by this much, a kart has fallen off: it is put back on the road. */
const FALLEN = 12;
/** How far a peer's kart may be from the track's height and still be drawn there. */
const UP_HERE = 10;

/** A colour token from tokens.css, for materials the stylesheet cannot reach. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

type Colors = {
  road: string;
  line: string;
  checker: string;
  curbA: string;
  curbB: string;
  ground: string;
  box: string;
  boxGlow: string;
  boost: string;
  tire: string;
  seat: string;
  bubble: string;
  flame: string;
  crew: string[];
};

const crewColor = (colors: Colors, index: number) => colors.crew[index % CREW_COLORS] ?? colors.curbA;

/** The shorter way round from `from` to `to`, at most `step` radians. */
function turnToward(from: number, to: number, step: number): number {
  const gap = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + Math.max(-step, Math.min(step, gap));
}

/** A flat strip along `line` (closed) from `inner` to `outer` meters across it, at height `y`, facing up. */
function strip(line: readonly Flat[], inner: number, outer: number, y: number): BufferGeometry {
  const [a, b] = [offsetLine(line, inner), offsetLine(line, outer)];
  const count = line.length;
  const positions = new Float32Array((count + 1) * 6);
  for (let index = 0; index <= count; index++) {
    const [near, far] = [a[index % count]!, b[index % count]!];
    positions.set([near[0], y, near[1], far[0], y, far[1]], index * 6);
  }
  const indices: number[] = [];
  for (let index = 0; index < count; index++) {
    const at = index * 2;
    indices.push(at, at + 1, at + 2, at + 1, at + 3, at + 2);
  }
  const normals = new Float32Array((count + 1) * 6);
  for (let index = 1; index < normals.length; index += 3) normals[index] = 1;
  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** A box turned to `yaw` about the vertical: its centre, its size (x across, y up, z along) and the turn. */
type TurnedBox = { center: Vec3; size: Vec3; yaw: number };

/** Blocks along `line` (closed) `offset` meters across it, one every `every` points, each as long as its stretch. */
function blocksAlong(line: readonly Flat[], offset: number, every: number, size: [number, number], y: number, extra = 0.05): TurnedBox[] {
  const side = offsetLine(line, offset).filter((_, index) => index % every === 0);
  return side.map((from, index) => {
    const to = side[(index + 1) % side.length]!;
    const [dx, dz] = [to[0] - from[0], to[1] - from[1]];
    const length = Math.hypot(dx, dz);
    return { center: [(from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2], size: [size[0], size[1], length + extra], yaw: Math.atan2(dx, dz) };
  });
}

/** The same blocks merged where they run on straight: the barriers' colliders. */
function mergeStraight(blocks: readonly TurnedBox[]): TurnedBox[] {
  const merged: TurnedBox[] = [];
  let run: TurnedBox[] = [];
  const flush = () => {
    if (!run.length) return;
    const [first, last] = [run[0]!, run.at(-1)!];
    const half = (box: TurnedBox, sign: number): Flat => [box.center[0] + Math.sin(box.yaw) * box.size[2] * 0.5 * sign, box.center[2] + Math.cos(box.yaw) * box.size[2] * 0.5 * sign];
    const [from, to] = [half(first, -1), half(last, 1)];
    const [dx, dz] = [to[0] - from[0], to[1] - from[1]];
    merged.push({ center: [(from[0] + to[0]) / 2, first.center[1], (from[1] + to[1]) / 2], size: [first.size[0], first.size[1], Math.hypot(dx, dz) + 0.4], yaw: Math.atan2(dx, dz) });
    run = [];
  };
  for (const block of blocks) {
    if (run.length && Math.abs(Math.atan2(Math.sin(block.yaw - run[0]!.yaw), Math.cos(block.yaw - run[0]!.yaw))) > 0.03) flush();
    run.push(block);
  }
  flush();
  return merged;
}

/** `boxes` drawn as one instanced mesh, each turned, in alternating colours. */
function TurnedBlocks({ boxes, colors }: { boxes: readonly TurnedBox[]; colors: readonly string[] }) {
  const mesh = useRef<InstancedMesh>(null);
  useEffect(() => {
    const blocks = mesh.current;
    if (!blocks) return;
    const matrix = new Matrix4();
    const turn = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const tint = new Color();
    boxes.forEach((box, index) => {
      matrix.compose(new Vector3(...box.center), turn.setFromAxisAngle(up, box.yaw), new Vector3(...box.size));
      blocks.setMatrixAt(index, matrix);
      blocks.setColorAt(index, tint.set(colors[index % colors.length]!));
    });
    blocks.instanceMatrix.needsUpdate = true;
    if (blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
    blocks.computeBoundingSphere();
  }, [boxes, colors]);
  return (
    <instancedMesh key={boxes.length} ref={mesh} args={[undefined, undefined, boxes.length]} raycast={noRaycast} receiveShadow castShadow>
      <boxGeometry />
      <meshStandardMaterial color="#ffffff" roughness={0.6} />
    </instancedMesh>
  );
}

/** The circuit: a floor under it all, the road with its edge lines, the checkered start, the curbs, and the colliders. */
const Circuit = memo(function Circuit({ colors }: { colors: Colors }) {
  const parts = useMemo(() => {
    const xs = MIDDLE.map((point) => point[0]);
    const zs = MIDDLE.map((point) => point[1]);
    const [minX, maxX, minZ, maxZ] = [Math.min(...xs) - 22, Math.max(...xs) + 22, Math.min(...zs) - 22, Math.max(...zs) + 22];
    const floor: Box = { center: [(minX + maxX) / 2, ARENA_Y - 0.5, (minZ + maxZ) / 2], size: [maxX - minX, 1, maxZ - minZ] };
    const road = strip(MIDDLE, -HALF_WIDTH, HALF_WIDTH, ARENA_Y + 0.02);
    const lines = [strip(MIDDLE, -HALF_WIDTH + 0.35, -HALF_WIDTH + 0.65, ARENA_Y + 0.03), strip(MIDDLE, HALF_WIDTH - 0.65, HALF_WIDTH - 0.35, ARENA_Y + 0.03)];
    // Curbs whose inner face is the road's edge, alternating colours every block.
    const curbs = [-1, 1].flatMap((side) => blocksAlong(MIDDLE, side * (HALF_WIDTH + 0.3), 2, [0.6, 0.7], ARENA_Y + 0.35));
    // The barriers stand a little inside the curbs, so a kart (wider than the body that drives it) stops at them.
    const walls = [-1, 1].flatMap((side) => mergeStraight(blocksAlong(MIDDLE, side * (HALF_WIDTH + 0.15), 2, [1.5, 2.4], ARENA_Y + 1.2, 0)));
    // The start line: a checkerboard two squares deep across the road.
    const { ahead, across } = frame(MIDDLE, 0);
    const squares: Box[] = [];
    const tints: string[] = [];
    for (let column = 0; column < 12; column++) {
      for (let row = 0; row < 2; row++) {
        const [a, b] = [column - 5.5, row - 0.5];
        squares.push({ center: [START[0] + across[0] * a + ahead[0] * b, ARENA_Y + 0.035, START[1] + across[1] * a + ahead[1] * b], size: [1, 0.02, 1] });
        tints.push((column + row) % 2 ? colors.checker : colors.line);
      }
    }
    return { floor, road, lines, curbs, walls, squares, tints };
  }, [colors]);
  useEffect(
    () => () => {
      parts.road.dispose();
      for (const line of parts.lines) line.dispose();
    },
    [parts],
  );
  return (
    <group userData={PASS}>
      <ArenaColliders boxes={[parts.floor]} />
      <RigidBody type="fixed" colliders={false}>
        {parts.walls.map((wall, index) => (
          <CuboidCollider key={index} args={[wall.size[0] / 2, wall.size[1] / 2, wall.size[2] / 2]} position={wall.center} rotation={[0, wall.yaw, 0]} />
        ))}
      </RigidBody>
      <mesh position={[parts.floor.center[0], ARENA_Y - 0.3, parts.floor.center[2]]} raycast={noRaycast} receiveShadow>
        <boxGeometry args={[parts.floor.size[0], 0.6, parts.floor.size[2]]} />
        <meshStandardMaterial color={colors.ground} roughness={0.95} />
      </mesh>
      <mesh geometry={parts.road} raycast={noRaycast} receiveShadow>
        <meshStandardMaterial color={colors.road} roughness={0.85} />
      </mesh>
      {parts.lines.map((line, index) => (
        <mesh key={index} geometry={line} raycast={noRaycast}>
          <meshStandardMaterial color={colors.line} roughness={0.7} />
        </mesh>
      ))}
      <ArenaBlocks boxes={parts.squares} colors={parts.tints} roughness={0.6} />
      <TurnedBlocks boxes={parts.curbs} colors={[colors.curbA, colors.curbB]} />
    </group>
  );
});

/** An item box: a turning, bobbing cube while it can be taken. */
function ItemBox({ at, ready, colors }: { at: Vec3; ready: boolean; colors: Colors }) {
  const mesh = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    const cube = mesh.current;
    if (!cube) return;
    const time = clock.elapsedTime + at[0] * 0.1;
    cube.rotation.set(time * 0.7, time * 1.3, 0);
    cube.position.y = at[1] + 1.1 + Math.sin(time * 2.4) * 0.12;
  });
  return (
    <mesh ref={mesh} position={[at[0], at[1] + 1.1, at[2]]} visible={ready} raycast={noRaycast} userData={PASS} castShadow>
      <boxGeometry args={[1.1, 1.1, 1.1]} />
      <meshStandardMaterial color={colors.box} emissive={colors.box} emissiveIntensity={0.25} roughness={0.35} transparent opacity={0.7} depthWrite={false} />
      <mesh raycast={noRaycast}>
        <boxGeometry args={[0.5, 0.5, 0.5]} />
        <meshStandardMaterial color={colors.boxGlow} emissive={colors.boxGlow} emissiveIntensity={0.8} />
      </mesh>
    </mesh>
  );
}

/** A boost pad: two glowing chevrons on the road, pointing the way it runs. */
function BoostPad({ at, colors }: { at: Vec3; colors: Colors }) {
  const yaw = headingOf(frame(MIDDLE, nearest([at[0], at[2]])).ahead);
  return (
    <group position={[at[0], at[1] + 0.05, at[2]]} rotation={[0, yaw, 0]} userData={PASS}>
      <mesh raycast={noRaycast}>
        <boxGeometry args={[3.6, 0.02, 4.6]} />
        <meshStandardMaterial color={colors.boost} transparent opacity={0.35} />
      </mesh>
      {[-1.1, 0.9].map((z) =>
        [1, -1].map((side) => (
          <mesh key={`${z}${side}`} position={[0.55 * side, 0.02, z + 0.25]} rotation={[0, Math.atan2(1.1 * side, -1.5), 0]} raycast={noRaycast}>
            <boxGeometry args={[0.45, 0.04, 1.86]} />
            <meshStandardMaterial color={colors.boost} emissive={colors.boost} emissiveIntensity={0.8} />
          </mesh>
        )),
      )}
    </group>
  );
}

type KartRefs = { flame: RefObject<Mesh | null>; bubble: RefObject<Mesh | null> };

/** A kart around its driver: body, nose, side pods, seat, rear wing and four wheels, in the racer's colour. */
function KartModel({ color, colors, refs }: { color: string; colors: Colors; refs: KartRefs }) {
  const paint = <meshStandardMaterial color={color} roughness={0.4} metalness={0.15} />;
  const rubber = <meshStandardMaterial color={colors.tire} roughness={0.9} />;
  return (
    <group userData={PASS}>
      <mesh position={[0, 0.42, 0.05]} raycast={noRaycast} castShadow>
        <boxGeometry args={[1.5, 0.36, 2.5]} />
        {paint}
      </mesh>
      <mesh position={[0, 0.36, 1.5]} raycast={noRaycast} castShadow>
        <boxGeometry args={[1.15, 0.26, 0.55]} />
        {paint}
      </mesh>
      {[-0.85, 0.85].map((x) => (
        <mesh key={x} position={[x, 0.38, -0.1]} raycast={noRaycast}>
          <boxGeometry args={[0.28, 0.3, 1.4]} />
          {paint}
        </mesh>
      ))}
      <mesh position={[0, 0.78, -0.75]} raycast={noRaycast}>
        <boxGeometry args={[0.95, 0.55, 0.2]} />
        <meshStandardMaterial color={colors.seat} roughness={0.8} />
      </mesh>
      <mesh position={[0, 1.08, -1.3]} raycast={noRaycast}>
        <boxGeometry args={[1.55, 0.08, 0.36]} />
        {paint}
      </mesh>
      {[-0.5, 0.5].map((x) => (
        <mesh key={x} position={[x, 0.8, -1.3]} raycast={noRaycast}>
          <boxGeometry args={[0.08, 0.5, 0.12]} />
          <meshStandardMaterial color={colors.seat} />
        </mesh>
      ))}
      {[-0.85, 0.85].flatMap((x) =>
        [-0.95, 0.95].map((z) => (
          <mesh key={`${x}${z}`} position={[x, 0.34, z]} rotation={[0, 0, Math.PI / 2]} raycast={noRaycast} castShadow>
            <cylinderGeometry args={[0.34, 0.34, 0.32, 18]} />
            {rubber}
          </mesh>
        )),
      )}
      <mesh ref={refs.flame} position={[0, 0.45, -1.8]} rotation={[-Math.PI / 2, 0, 0]} visible={false} raycast={noRaycast}>
        <coneGeometry args={[0.3, 1.0, 14]} />
        <meshStandardMaterial color={colors.flame} emissive={colors.flame} emissiveIntensity={1.4} transparent opacity={0.85} />
      </mesh>
      <mesh ref={refs.bubble} position={[0, 1.2, 0]} visible={false} raycast={noRaycast}>
        <sphereGeometry args={[1.9, 24, 16]} />
        <meshStandardMaterial color={colors.bubble} transparent opacity={0.35} roughness={0.1} depthWrite={false} />
      </mesh>
    </group>
  );
}

function useKartRefs(): KartRefs {
  const flame = useRef<Mesh>(null);
  const bubble = useRef<Mesh>(null);
  return useMemo(() => ({ flame, bubble }), []);
}

/** Shows a kart's booster flame and bubble while the server's times say so (or `boosting` locally). */
function showStatus(refs: KartRefs, racer: KartRacer | undefined, now: number, boosting = false) {
  if (refs.flame.current) refs.flame.current.visible = boosting || (!!racer && now < racer.boostUntil);
  if (refs.bubble.current) refs.bubble.current.visible = !!racer && now < racer.trappedUntil;
}

/** A bot's kart where its route has it, facing the way it goes, its name over it. */
function BotKart({ route, racer, colors, serverNow }: { route: KartView['bots'][number]['route']; racer: KartRacer | undefined; colors: Colors; serverNow: () => number }) {
  const group = useRef<Group>(null);
  const yaw = useRef(START_HEADING);
  const refs = useKartRefs();
  const latest = useRef({ route, racer });
  latest.current = { route, racer };
  useFrame((_, delta) => {
    const self = group.current;
    if (!self) return;
    const now = serverNow();
    const { route: way, racer: who } = latest.current;
    const [at, ahead] = [routeAt(way, now), routeAt(way, now + 200)];
    const [dx, dz] = [ahead[0] - at[0], ahead[2] - at[2]];
    if (dx * dx + dz * dz > 1e-4) yaw.current = turnToward(yaw.current, Math.atan2(dx, dz), delta * 10);
    self.position.set(at[0], ARENA_Y, at[2]);
    self.rotation.y = yaw.current;
    showStatus(refs, who, now);
  });
  return (
    <group ref={group} userData={PASS}>
      <KartModel color={crewColor(colors, racer?.color ?? 0)} colors={colors} refs={refs} />
      <mesh position={[0, 1.05, -0.1]} raycast={noRaycast}>
        <capsuleGeometry args={[0.32, 0.45, 6, 12]} />
        <meshStandardMaterial color={crewColor(colors, racer?.color ?? 0)} roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.72, -0.05]} raycast={noRaycast}>
        <sphereGeometry args={[0.36, 18, 12]} />
        <meshStandardMaterial color={colors.seat} roughness={0.3} metalness={0.2} />
      </mesh>
      {racer && (
        <Html position={[0, 2.6, 0]} center zIndexRange={NAME_LAYERS} className="mg-kart-name" pointerEvents="none">
          {racer.name}
        </Html>
      )}
    </group>
  );
}

/** Another person's kart under their avatar, where the live room last placed them, facing the way they go. */
function PeerKart({ peer, racer, colors, serverNow }: { peer: string; racer: KartRacer | undefined; colors: Colors; serverNow: () => number }) {
  const players = useLivePlayers();
  const group = useRef<Group>(null);
  const yaw = useRef(START_HEADING);
  const last = useRef<Vector3 | null>(null);
  const refs = useKartRefs();
  const latest = useRef({ players, racer });
  latest.current = { players, racer };
  useFrame((_, delta) => {
    const self = group.current;
    if (!self) return;
    const state = latest.current.players?.get(peer);
    const placed = !!state && Math.abs(state.position[1] - ARENA_Y) < UP_HERE;
    self.visible = placed;
    if (!state || !placed) {
      last.current = null;
      return;
    }
    const target = new Vector3(state.position[0], ARENA_Y, state.position[2]);
    if (!last.current) last.current = target.clone();
    const [dx, dz] = [target.x - last.current.x, target.z - last.current.z];
    if (dx * dx + dz * dz > 0.04) yaw.current = turnToward(yaw.current, Math.atan2(dx, dz), delta * 8);
    // Eased toward the latest place, as the avatar is.
    last.current.lerp(target, 1 - Math.exp(-delta * 12));
    self.position.copy(last.current);
    self.rotation.y = yaw.current;
    showStatus(refs, latest.current.racer, serverNow());
  });
  return (
    <group ref={group} visible={false}>
      <KartModel color={crewColor(colors, racer?.color ?? 0)} colors={colors} refs={refs} />
    </group>
  );
}

/** Rides the chase camera behind the kart while mounted, and puts the island's camera back after. */
function useChaseCamera() {
  const store = useGaesupStoreApi();
  useEffect(() => {
    const state = store.getState();
    const control: CameraType = state.mode?.control ?? 'thirdPerson';
    const option = state.cameraOption ?? {};
    const before: CameraOption = Object.fromEntries((Object.keys(CHASE) as (keyof CameraOption)[]).map((key) => [key, option[key]]));
    state.setMode({ control: 'chase' });
    state.setCameraOption(CHASE);
    return () => {
      const now = store.getState();
      now.setMode({ control });
      now.setCameraOption(before);
    };
  }, [store]);
}

/** Whether a key event belongs to a field being typed in. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);

/**
 * The viewer's own kart: the keys (taken before the island's walking hears them), the kart's motion applied to the
 * player's body every frame after the engine's own, the chase camera, and the kart drawn around the driver.
 */
function Driver({ view, racer, act, serverNow, teleport, body: player, colors }: { view: KartView; racer: KartRacer; colors: Colors } & Pick<GameProps, 'act' | 'serverNow' | 'teleport' | 'body'>) {
  const { activeState } = useStateSystem();
  const interaction = useInteractionSystem();
  const route = useClickNavigationRoute();
  const held = useRef(new Set<string>());
  const kart = useRef(startKart(START_HEADING));
  const pad = useRef(0);
  const group = useRef<Group>(null);
  const refs = useKartRefs();
  const latest = useRef({ view, racer, interaction, route });
  latest.current = { view, racer, interaction, route };
  const fire = useRef(() => {});
  fire.current = () => {
    if (view.me?.item && view.phase === 'race' && racer.finishedAt === null) act({ do: 'item' });
  };
  useChaseCamera();

  useEffect(() => {
    const keys = held.current;
    const down = (event: KeyboardEvent) => {
      if (!isKartKey(event.code) || typing(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if ((KART_KEYS.item as readonly string[]).includes(event.code) && !event.repeat) fire.current();
      keys.add(event.code);
    };
    // Releases reach the island too, so a key it saw go down before the race is not left held there.
    const up = (event: KeyboardEvent) => {
      if (!isKartKey(event.code)) return;
      keys.delete(event.code);
      if (!typing(event.target)) event.preventDefault();
    };
    const lost = () => keys.clear();
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', lost);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', lost);
      keys.clear();
    };
  }, []);

  useEngineFrame(
    'prePhysics',
    (delta) => {
      const body = player();
      if (!body) return;
      const { view: now, racer: me, interaction: input, route: clicks } = latest.current;
      // A click-to-move walk would turn the driver toward where they clicked.
      if (input.mouse.isActive) {
        clicks.clearClickNavigationRoute();
        input.updateMouse({ isActive: false, shouldRun: false });
      }
      let at: { x: number; y: number; z: number };
      let velocity: { x: number; y: number; z: number };
      try {
        at = body.translation();
        velocity = body.linvel();
      } catch {
        return;
      }
      if (at.y < ARENA_Y - FALLEN) {
        const back = MIDDLE[nearest([at.x, at.z])]!;
        teleport([back[0], ARENA_Y, back[1]]);
        kart.current = { ...kart.current, speed: 0 };
        return;
      }
      const server = serverNow();
      const local = performance.now();
      const dt = Math.min(0.05, Math.max(0, delta));
      const state = kart.current;
      const way = state.heading + state.slip;
      const measured = velocity.x * Math.sin(way) + velocity.z * Math.cos(way);
      if (now.boosts.some((spot) => Math.hypot(spot[0] - at.x, spot[2] - at.z) < PAD_REACH && Math.abs(spot[1] - at.y) < 4)) pad.current = local + PAD_TIME;
      const boosted = server < me.boostUntil || local < pad.current;
      const stopped = server < now.startsAt || server < me.trappedUntil;
      const next = stepKart({ ...state, speed: afterContact(state.speed, measured) }, readKeys(held.current), dt, { now: local, boosted, held: stopped });
      kart.current = next;
      const [vx, vz] = kartVelocity(next);
      // The engine damps a body that is not walking; this frame's step takes that much back.
      const keep = 1 + body.linearDamping() / 60;
      body.setLinvel({ x: vx * keep, y: velocity.y, z: vz * keep }, true);
      activeState.euler.y = next.heading;
    },
    { order: AFTER_MOTION_FRAME_ORDER },
  );

  useEngineFrame('lateUpdate', () => {
    const self = group.current;
    const body = player();
    if (!self || !body) return;
    // Where the driver is drawn (eased between physics steps, as the camera follows it), else where the body is.
    let spot: { x: number; z: number } | undefined = activeState.presentedPosition;
    if (!spot) {
      try {
        spot = body.translation();
      } catch {
        return;
      }
    }
    self.position.set(spot.x, ARENA_Y, spot.z);
    self.rotation.y = kart.current.heading;
    showStatus(refs, latest.current.racer, serverNow(), performance.now() < pad.current || performance.now() < kart.current.turboUntil);
  });

  return (
    <group ref={group}>
      <KartModel color={crewColor(colors, racer.color)} colors={colors} refs={refs} />
    </group>
  );
}

/** The racer of `id` in the view. */
const racerOf = (view: KartView, id: string | null | undefined) => view.racers.find((racer) => racer.id === id);

/**
 * The circuit in the sky over the island, its item boxes and boost pads, every kart (the viewer's own driven here, the
 * others where the live room and the bots' routes have them), and the trip there at the start and home at the end.
 */
export function KartWorld(props: GameProps<KartView>) {
  const { view, session, me, act, serverNow, teleport, body } = props;
  const colors = useMemo<Colors>(
    () => ({
      road: token('--mg-kart-road'),
      line: token('--mg-kart-line'),
      checker: token('--mg-kart-checker'),
      curbA: token('--mg-kart-curb-a'),
      curbB: token('--mg-kart-curb-b'),
      ground: token('--mg-kart-ground'),
      box: token('--mg-kart-box'),
      boxGlow: token('--mg-kart-box-glow'),
      boost: token('--mg-kart-boost'),
      tire: token('--mg-kart-tire'),
      seat: token('--mg-kart-seat'),
      bubble: token('--mg-kart-bubble'),
      flame: token('--mg-kart-flame'),
      crew: Array.from({ length: CREW_COLORS }, (_, index) => token(`--mg-crew-${index}`)),
    }),
    [],
  );
  const racing = view.phase !== 'ended';
  useArenaTrip(racing ? view.spawn : null, props);
  const mine = racerOf(view, me?.id);
  const peers = session.players.filter((player) => player.id !== session.you && player.peer && racerOf(view, player.id));
  return (
    <group>
      <Circuit colors={colors} />
      {view.boxes.map((box) => (
        <ItemBox key={box.id} at={box.position} ready={box.ready} colors={colors} />
      ))}
      {view.boosts.map((at, index) => (
        <BoostPad key={index} at={at} colors={colors} />
      ))}
      {view.bots.map((bot) => (
        <BotKart key={bot.id} route={bot.route} racer={racerOf(view, bot.id)} colors={colors} serverNow={serverNow} />
      ))}
      {peers.map((player) => (
        <PeerKart key={player.id} peer={player.peer!} racer={racerOf(view, player.id)} colors={colors} serverNow={serverNow} />
      ))}
      {racing && mine && view.me && <Driver view={view} racer={mine} act={act} serverNow={serverNow} teleport={teleport} body={body} colors={colors} />}
    </group>
  );
}
