import { memo, useEffect, useMemo, useRef } from 'react';

import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { Color, Matrix4, Quaternion, Vector3, type Group, type InstancedMesh, type Mesh } from 'three';

import { AFTER_MOTION_FRAME_ORDER, useEngineFrame, useGaesupStoreApi, useInteractionSystem, useStateSystem, type CameraOption, type CameraType } from 'gaesup-world';
import { useClickNavigationRoute } from 'gaesup-world/navigation';

import { useLivePlayers } from '../../minihome/live';
import { ArenaBlocks, standFor, useArenaTrip, type Box } from '../arena';
import type { GameProps } from '../game';
import { useHidePeers } from '../hiddenPeers';
import type { Vec3 } from '../protocol';
import { readKartInput } from './controls';
import type { KartRacer, KartView } from './index';
import { IslandScenery, type SceneryColors } from './IslandScenery';
import { KartModel, useKartRefs, type KartPalette, type KartRefs } from './KartModel';
import { afterContact, isKartKey, KART_KEYS, kartVelocity, startKart, stepKart, type KartState } from './physics';
import { routeAt } from './route';
import { blocksAlong, mergeStraight, strip, type TurnedBox } from './shapes';
import { frame, HALF_WIDTH, headingOf, MIDDLE, nearest, START, START_HEADING, TRACK_Y } from './track';

/** Markers are left out of picking, so a click on one walks to the ground under it. */
const noRaycast = () => null;
/** Left out of the camera's collision: the chase camera rides over the track, and karts and boxes pass under it. */
const PASS = { intangible: true };
/** Names over the karts stay under the page's panels. */
const NAME_LAYERS: [number, number] = [12, 0];
const CREW_COLORS = 12;
/** The camera behind the kart while it races. */
const CHASE: CameraOption = { xDistance: 14, yDistance: 8, zDistance: 14, fov: 52, zoom: 1, smoothing: { position: 0.25, rotation: 0.2, fov: 0.1 } };
/** A boost pad's reach and how long it pushes, ms. */
const PAD_REACH = 3;
const PAD_TIME = 1_200;
/** Below the track by this much, a kart has fallen off: it is put back on the road. */
const FALLEN = 12;
/** A kart that moved this far between two frames was put somewhere (its start, the road after a fall, its place again
 * after its canvas was set up anew): it sets off again from there, facing the way the track runs. */
const JUMPED = 8;
/** How far a peer's kart may be from the track's height and still be drawn there. */
const UP_HERE = 10;

/** A colour token from tokens.css, for materials the stylesheet cannot reach. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

type Colors = KartPalette &
  SceneryColors & {
    road: string;
    curbA: string;
    curbB: string;
    rail: string;
    box: string;
    boxGlow: string;
    boost: string;
    crew: string[];
  };

const crewColor = (colors: Colors, index: number) => colors.crew[index % CREW_COLORS] ?? colors.curbA;

/** The shorter way round from `from` to `to`, at most `step` radians. */
function turnToward(from: number, to: number, step: number): number {
  const gap = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + Math.max(-step, Math.min(step, gap));
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

/** The circuit on the island's ground: the road with its edge lines, the checkered start, the curbs, the rails behind them, and the barriers. */
const Circuit = memo(function Circuit({ colors }: { colors: Colors }) {
  const parts = useMemo(() => {
    const road = strip(MIDDLE, -HALF_WIDTH, HALF_WIDTH, TRACK_Y + 0.02);
    const lines = [strip(MIDDLE, -HALF_WIDTH + 0.35, -HALF_WIDTH + 0.65, TRACK_Y + 0.03), strip(MIDDLE, HALF_WIDTH - 0.65, HALF_WIDTH - 0.35, TRACK_Y + 0.03)];
    // Curbs whose inner face is the road's edge, alternating colours every block.
    const curbs = [-1, 1].flatMap((side) => blocksAlong(MIDDLE, side * (HALF_WIDTH + 0.3), 2, [0.6, 0.24], TRACK_Y + 0.12));
    // White rails behind them, framing the road.
    const rails = [-1, 1].flatMap((side) => blocksAlong(MIDDLE, side * (HALF_WIDTH + 1.6), 3, [0.3, 0.75], TRACK_Y + 0.38, 0.12));
    // The barriers stand a little inside the curbs, so a kart (wider than the body that drives it) stops at them.
    const walls = [-1, 1].flatMap((side) => mergeStraight(blocksAlong(MIDDLE, side * (HALF_WIDTH + 0.15), 2, [1.5, 2.4], TRACK_Y + 1.2, 0)));
    // The start line: a checkerboard two squares deep across the road.
    const { ahead, across } = frame(MIDDLE, 0);
    const squares: Box[] = [];
    const tints: string[] = [];
    for (let column = 0; column < 12; column++) {
      for (let row = 0; row < 2; row++) {
        const [a, b] = [column - 5.5, row - 0.5];
        squares.push({ center: [START[0] + across[0] * a + ahead[0] * b, TRACK_Y + 0.035, START[1] + across[1] * a + ahead[1] * b], size: [1, 0.02, 1] });
        tints.push((column + row) % 2 ? colors.checker : colors.line);
      }
    }
    return { road, lines, curbs, rails, walls, squares, tints };
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
      <RigidBody type="fixed" colliders={false}>
        {parts.walls.map((wall, index) => (
          <CuboidCollider key={index} args={[wall.size[0] / 2, wall.size[1] / 2, wall.size[2] / 2]} position={wall.center} rotation={[0, wall.yaw, 0]} />
        ))}
      </RigidBody>
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
      <TurnedBlocks boxes={parts.rails} colors={[colors.rail]} />
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

/** Shows a kart's booster flame and bubble while the server's times say so (or `boosting` locally). */
function showStatus(refs: KartRefs, racer: KartRacer | undefined, now: number, boosting = false) {
  if (refs.flame.current) refs.flame.current.visible = boosting || (!!racer && now < racer.boostUntil);
  if (refs.bubble.current) refs.bubble.current.visible = !!racer && now < racer.trappedUntil;
}

/** A name over a kart. */
function Name({ name }: { name: string }) {
  return (
    <Html position={[0, 2.5, 0]} center zIndexRange={NAME_LAYERS} className="mg-kart-name" pointerEvents="none">
      {name}
    </Html>
  );
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
    self.position.set(at[0], TRACK_Y, at[2]);
    self.rotation.y = yaw.current;
    showStatus(refs, who, now);
  });
  return (
    <group ref={group} userData={PASS}>
      <KartModel color={crewColor(colors, racer?.color ?? 0)} colors={colors} refs={refs} />
      {racer && <Name name={racer.name} />}
    </group>
  );
}

/** Another person's kart where the live room last placed them (their own figure is hidden meanwhile), facing the way they go. */
function PeerKart({ peer, racer, name, colors, serverNow }: { peer: string; racer: KartRacer | undefined; name: string; colors: Colors; serverNow: () => number }) {
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
    const placed = !!state && Math.abs(state.position[1] - TRACK_Y) < UP_HERE;
    self.visible = placed;
    if (!state || !placed) {
      last.current = null;
      return;
    }
    const target = new Vector3(state.position[0], TRACK_Y, state.position[2]);
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
    <group ref={group} visible={false} userData={PASS}>
      <KartModel color={crewColor(colors, racer?.color ?? 0)} colors={colors} refs={refs} />
      <Name name={name} />
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

/** The way the track runs at its middle line's point nearest `x`, `z`. */
const headingNear = (x: number, z: number) => headingOf(frame(MIDDLE, nearest([x, z])).ahead);

/**
 * The viewer's own kart: the keys (taken before the island's walking hears them) and the touch buttons (kart/controls.ts),
 * the kart's motion applied to the player's body every frame after the engine's own, the chase camera, and the kart
 * drawn around the driver (whose own figure is hidden while they drive). It sets off facing the way the track runs
 * where the body stands, and again so wherever the body is put: a Driver mounted again mid-race (its socket came back)
 * goes on that way, not the start's. Held through the countdown, in a bubble, and once it has finished.
 */
function Driver({ view, racer, act, serverNow, teleport, body: player, colors }: { view: KartView; racer: KartRacer; colors: Colors } & Pick<GameProps, 'act' | 'serverNow' | 'teleport' | 'body'>) {
  const { activeState } = useStateSystem();
  const interaction = useInteractionSystem();
  const route = useClickNavigationRoute();
  const held = useRef(new Set<string>());
  const kart = useRef<KartState | null>(null);
  const lastAt = useRef<{ x: number; z: number } | null>(null);
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
    const hidden = () => {
      if (document.hidden) keys.clear();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', lost);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', lost);
      document.removeEventListener('visibilitychange', hidden);
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
      if (at.y < TRACK_Y - FALLEN) {
        // Off the track: back on the road nearest where it fell.
        const road = MIDDLE[nearest([at.x, at.z])]!;
        teleport([road[0], TRACK_Y, road[1]]);
        kart.current = null;
        return;
      }
      const moved = lastAt.current ? Math.hypot(at.x - lastAt.current.x, at.z - lastAt.current.z) : 0;
      lastAt.current = { x: at.x, z: at.z };
      if (moved > JUMPED) kart.current = null;
      const server = serverNow();
      const local = performance.now();
      const dt = Math.min(0.05, Math.max(0, delta));
      const state = (kart.current ??= startKart(headingNear(at.x, at.z)));
      const way = state.heading + state.slip;
      const measured = velocity.x * Math.sin(way) + velocity.z * Math.cos(way);
      if (now.boosts.some((spot) => Math.hypot(spot[0] - at.x, spot[2] - at.z) < PAD_REACH && Math.abs(spot[1] - at.y) < 4)) pad.current = local + PAD_TIME;
      const boosted = server < me.boostUntil || local < pad.current;
      const stopped = server < now.startsAt || server < me.trappedUntil || me.finishedAt !== null;
      const next = stepKart({ ...state, speed: afterContact(state.speed, measured) }, readKartInput(held.current), dt, { now: local, boosted, held: stopped });
      kart.current = next;
      const [vx, vz] = kartVelocity(next);
      try {
        // The engine damps a body that is not walking; this frame's step takes that much back.
        const keep = 1 + body.linearDamping() / 60;
        body.setLinvel({ x: vx * keep, y: velocity.y, z: vz * keep }, true);
      } catch {
        return;
      }
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
    self.position.set(spot.x, TRACK_Y, spot.z);
    const state = kart.current;
    self.rotation.y = state?.heading ?? headingNear(spot.x, spot.z);
    showStatus(refs, latest.current.racer, serverNow(), performance.now() < pad.current || performance.now() < (state?.turboUntil ?? 0));
  });

  return (
    <group ref={group} userData={PASS}>
      <KartModel color={crewColor(colors, racer.color)} colors={colors} refs={refs} />
    </group>
  );
}

/** The racer of `id` in the view. */
const racerOf = (view: KartView, id: string | null | undefined) => view.racers.find((racer) => racer.id === id);

/**
 * The racing island in the island's place (see IslandScenery.tsx), the circuit on it, its item boxes and boost pads,
 * every kart (the viewer's own driven here, the others where the live room and the bots' routes have them, each
 * person's own figure hidden while they race), and the trip there at the start (a racer to their grid slot, whoever
 * watches to the stand) and home at the end.
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
      rail: token('--mg-kart-rail'),
      ground: token('--mg-kart-ground'),
      sand: token('--mg-kart-sand'),
      shallow: token('--mg-kart-shallow'),
      sea: token('--mg-kart-sea'),
      tree: token('--mg-kart-tree'),
      trunk: token('--mg-kart-trunk'),
      gantry: token('--mg-kart-gantry'),
      box: token('--mg-kart-box'),
      boxGlow: token('--mg-kart-box-glow'),
      boost: token('--mg-kart-boost'),
      tire: token('--mg-kart-tire'),
      seat: token('--mg-kart-seat'),
      bubble: token('--mg-kart-bubble'),
      flame: token('--mg-kart-flame'),
      metal: token('--mg-kart-metal'),
      suit: token('--mg-kart-suit'),
      skin: token('--mg-kart-skin'),
      face: token('--mg-kart-face'),
      crew: Array.from({ length: CREW_COLORS }, (_, index) => token(`--mg-crew-${index}`)),
    }),
    [],
  );
  const racing = view.phase !== 'ended';
  useArenaTrip(racing ? (view.spawn ?? standFor(session)) : null, props);
  const mine = racerOf(view, me?.id);
  const peers = session.players.filter((player) => player.id !== session.you && player.peer && racerOf(view, player.id));
  // Each racer's own figure gives way to their kart (and its driver).
  useHidePeers('kart', racing ? peers.map((player) => player.peer) : []);
  return (
    <group>
      <IslandScenery colors={colors} />
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
        <PeerKart key={player.id} peer={player.peer!} racer={racerOf(view, player.id)} name={player.name} colors={colors} serverNow={serverNow} />
      ))}
      {racing && mine && view.me && <Driver view={view} racer={mine} act={act} serverNow={serverNow} teleport={teleport} body={body} colors={colors} />}
    </group>
  );
}
