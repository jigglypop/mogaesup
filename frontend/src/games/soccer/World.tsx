import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';

import { useFrame } from '@react-three/fiber';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Quaternion, Vector3, type Mesh } from 'three';

import { createTileSampler } from 'gaesup-world/building';

import { useLivePlayers } from '../../minihome/live';
import type { GameProps } from '../game';
import type { Vec3 } from '../protocol';
import { useGameRoom } from '../room';
import { standing } from '../teleport';
import { fromField, GOAL_DEPTH, rollBall, type FieldView } from './field';
import type { SoccerView, Team } from './index';
import { useKickKey } from './kick';

/** Nothing here is picked, so a click on it walks to the ground under it. */
const noRaycast = () => null;
/** A colour token from tokens.css, for materials the stylesheet cannot reach. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const BALL_RADIUS = 0.3;
/** How quickly a correction from the server's latest view fades into the drawn ball (s). */
const BLEND = 0.1;
/** A jump farther than this (m) is the ball put back for a kickoff: drawn there at once. */
const SNAP = 3;
const LINE = 0.12;
/** Chalk and rings lie this far over the ground drawn under them. */
const LIFT = 0.04;
/** How far apart the chalk follows the ground (m). */
const DRAPE = 0.5;
const GOAL_HEIGHT = 2;
const POST = 0.07;
const RING = [0.5, 0.68] as const;
/** How quickly a ring catches up with where a visitor was last seen (1/s). */
const FOLLOW = 14;
/** The most the engine's sand and snow covers rise over their tiles (m): lumps of sand would hide flat chalk. */
const COVER: Partial<Record<string, number>> = { sand: 0.22, snowfield: 0.34 };

const UP = new Vector3(0, 1, 0);

type Ground = {
  /** The top of the tile at (x, z). */
  top: (x: number, z: number) => number;
  /** How high a sand or snow cover may rise over it there. */
  cover: (x: number, z: number) => number;
};

/** The island's ground under the field, from the island this page has loaded; the field's own plane without one. */
function useGround(plane: number): Ground {
  const room = useGameRoom();
  return useMemo<Ground>(() => {
    const building = room?.building();
    if (!building) return { top: () => plane, cover: () => 0 };
    const sampler = createTileSampler({ tileGroups: building.tileGroups, worldSurface: building.worldSurface });
    return {
      top: (x, z) => sampler.heightAt(x, z, plane),
      cover: (x, z) => {
        const tile = sampler.at(x, z)?.tile;
        return tile && (tile.shape ?? 'box') === 'box' ? (COVER[tile.objectType ?? 'none'] ?? 0) : 0;
      },
    };
  }, [room, plane]);
}

/** A strip `width` wide along each path of ground points `[x, z]`, laid over `ground` with no gaps at the joints. */
function ribbon(paths: [number, number][][], width: number, ground: Ground): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const path of paths) {
    path.forEach(([x, z], index) => {
      const [px, pz] = path[Math.max(0, index - 1)]!;
      const [nx, nz] = path[Math.min(path.length - 1, index + 1)]!;
      const length = Math.hypot(nx - px, nz - pz) || 1;
      const [ax, az] = [(-(nz - pz) / length) * (width / 2), ((nx - px) / length) * (width / 2)];
      const y = ground.top(x, z) + ground.cover(x, z) + LIFT;
      const at = positions.length / 3;
      positions.push(x + ax, y, z + az, x - ax, y, z - az);
      if (index > 0) indices.push(at - 2, at - 1, at, at - 1, at + 1, at);
    });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** The field's chalk as ground paths: the four lines round it (each running on past the corners), the halfway line, the centre circle and spot. */
function chalkPaths(field: FieldView): [number, number][][] {
  const { halfLength: length, halfWidth: width } = field;
  const ground = (u: number, v: number): [number, number] => {
    const [x, , z] = fromField(field, u, v);
    return [x, z];
  };
  const straight = (from: [number, number], to: [number, number]) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / DRAPE));
    return Array.from({ length: steps + 1 }, (_, step) => ground(from[0] + ((to[0] - from[0]) * step) / steps, from[1] + ((to[1] - from[1]) * step) / steps));
  };
  const round = (radius: number) => {
    const steps = Math.max(12, Math.ceil((2 * Math.PI * radius) / DRAPE));
    return Array.from({ length: steps + 1 }, (_, step) => ground(radius * Math.cos((2 * Math.PI * step) / steps), radius * Math.sin((2 * Math.PI * step) / steps)));
  };
  const [l, w] = [length + LINE / 2, width + LINE / 2];
  return [
    straight([-l, -width], [l, -width]),
    straight([-l, width], [l, width]),
    straight([-length, -w], [-length, w]),
    straight([length, -w], [length, w]),
    straight([0, -width], [0, width]),
    round(Math.min(3, width - 1)),
    round(0.09),
  ];
}

/** The field's chalk, following the ground. */
function Chalk({ field, ground, color }: { field: FieldView; ground: Ground; color: string }) {
  const geometry = useMemo(() => {
    const paths = chalkPaths(field);
    return [ribbon(paths.slice(0, -1), LINE, ground), ribbon(paths.slice(-1), 0.18, ground)] as const;
  }, [field, ground]);
  useEffect(() => () => geometry.forEach((part) => part.dispose()), [geometry]);
  return (
    <group>
      {geometry.map((part, index) => (
        <mesh key={index} geometry={part} raycast={noRaycast}>
          <meshBasicMaterial color={color} side={DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

/** A post or bar of a goal frame, from `a` to `b` (in the field's own frame). */
function Bar({ a, b, color }: { a: Vec3; b: Vec3; color: string }) {
  const [position, quaternion, length] = useMemo(() => {
    const from = new Vector3(...a);
    const along = new Vector3(...b).sub(from);
    const middle = from.clone().addScaledVector(along, 0.5);
    return [middle, new Quaternion().setFromUnitVectors(UP, along.clone().normalize()), along.length()] as const;
  }, [a, b]);
  return (
    <mesh position={position} quaternion={quaternion} raycast={noRaycast}>
      <cylinderGeometry args={[POST, POST, length, 10]} />
      <meshStandardMaterial color={color} roughness={0.4} />
    </mesh>
  );
}

/** A goal's frame behind the end line at `end` (−1 or 1), in the colour of the team defending it. */
function Goal({ field, end, color }: { field: FieldView; end: -1 | 1; color: string }) {
  const bars = useMemo(() => {
    const [front, back, side] = [end * field.halfLength, end * (field.halfLength + GOAL_DEPTH), field.mouth / 2];
    const top = (u: number, v: number): Vec3 => [u, GOAL_HEIGHT, v];
    const foot = (u: number, v: number): Vec3 => [u, 0, v];
    return [
      [foot(front, -side), top(front, -side)],
      [foot(front, side), top(front, side)],
      [top(front, -side), top(front, side)],
      [foot(back, -side), top(back, -side)],
      [foot(back, side), top(back, side)],
      [top(back, -side), top(back, side)],
      [top(front, -side), top(back, -side)],
      [top(front, side), top(back, side)],
    ] as [Vec3, Vec3][];
  }, [field.halfLength, field.mouth, end]);
  return (
    <group>
      {bars.map(([a, b], index) => (
        <Bar key={index} a={a} b={b} color={color} />
      ))}
    </group>
  );
}

/**
 * Both goals, drawn in the field's own frame: its x along the long side, z across. A goal is the same either side of the
 * long side, so one turn of the frame serves a field along either axis.
 */
function Goals({ field, colors }: { field: FieldView; colors: Record<Team, string> }) {
  return (
    <group position={field.center} rotation-y={field.axis === 'x' ? 0 : -Math.PI / 2}>
      <Goal field={field} end={-1} color={colors.a} />
      <Goal field={field} end={1} color={colors.b} />
    </group>
  );
}

/**
 * The ball where the server's rolling puts it now: rolled on from the latest view by the server's clock, with what a
 * new view corrects blended in over a tenth of a second (a reset for a kickoff is drawn at once), turning as it rolls.
 */
function Ball({ view, ground, serverNow, color }: { view: RefObject<SoccerView>; ground: Ground; serverNow: () => number; color: string }) {
  const mesh = useRef<Mesh>(null);
  const track = useMemo(() => ({ from: null as SoccerView['ball'] | null, shown: null as Vector3 | null, error: new Vector3() }), []);
  const scratch = useMemo(() => ({ next: new Vector3(), axis: new Vector3(), turn: new Quaternion() }), []);
  useFrame((_, delta) => {
    const ball = mesh.current;
    const { ball: sent, field } = view.current;
    if (!ball) return;
    const [x, , z] = rollBall(sent, field, serverNow());
    if (track.from !== sent) {
      track.from = sent;
      if (track.shown) track.error.set(track.shown.x - x, 0, track.shown.z - z);
      if (track.error.length() > SNAP) track.error.set(0, 0, 0);
    }
    track.error.multiplyScalar(Math.exp(-delta / BLEND));
    const [bx, bz] = [x + track.error.x, z + track.error.z];
    // On sand or snow it rides about halfway up the cover.
    const next = scratch.next.set(bx, ground.top(bx, bz) + ground.cover(bx, bz) / 2 + BALL_RADIUS, bz);
    if (track.shown) {
      const [dx, dz] = [next.x - track.shown.x, next.z - track.shown.z];
      const moved = Math.hypot(dx, dz);
      if (moved > 1e-5 && moved < SNAP) {
        ball.quaternion.premultiply(scratch.turn.setFromAxisAngle(scratch.axis.set(dz / moved, 0, -dx / moved), moved / BALL_RADIUS));
      }
    } else {
      track.shown = new Vector3();
    }
    track.shown.copy(next);
    ball.position.copy(next);
  });
  return (
    <mesh ref={mesh} raycast={noRaycast} castShadow>
      <icosahedronGeometry args={[BALL_RADIUS, 1]} />
      <meshStandardMaterial color={color} roughness={0.55} flatShading />
    </mesh>
  );
}

/** A team ring on the ground under a player, following `where` (smoothly for a visitor, whose updates come in steps). */
function Ring({ where, ground, color, smooth }: { where: () => Vec3 | null; ground: Ground; color: string; smooth: boolean }) {
  const mesh = useRef<Mesh>(null);
  const placed = useRef(false);
  useFrame((_, delta) => {
    const ring = mesh.current;
    if (!ring) return;
    const at = where();
    ring.visible = !!at;
    if (!at) {
      placed.current = false;
      return;
    }
    const keep = smooth && placed.current ? Math.exp(-delta * FOLLOW) : 0;
    const [x, z] = [at[0] + (ring.position.x - at[0]) * keep, at[2] + (ring.position.z - at[2]) * keep];
    ring.position.set(x, ground.top(x, z) + ground.cover(x, z) + LIFT, z);
    placed.current = true;
  });
  return (
    <mesh ref={mesh} rotation-x={-Math.PI / 2} raycast={noRaycast} visible={false}>
      <ringGeometry args={[RING[0], RING[1], 40]} />
      <meshBasicMaterial color={color} transparent opacity={0.9} depthWrite={false} />
    </mesh>
  );
}

/**
 * The field, both goals and the ball in the island, and each player's team ring: the viewer's under their own character,
 * the others' where the live room last saw them. At each kickoff it moves the viewer to their spot; while play runs, F
 * kicks.
 */
export function SoccerWorld({ view, session, me, act, serverNow, teleport }: GameProps<SoccerView>) {
  const colors = useMemo(() => ({ a: token('--mg-soccer-a'), b: token('--mg-soccer-b'), line: token('--mg-soccer-line') }), []);
  const latest = useRef(view);
  latest.current = view;
  const live = useLivePlayers();
  const playerRef = useGameRoom()?.playerRef;
  // The same field all game long, though every view brings a new copy of it.
  const { center: [x, y, z], axis, halfLength, halfWidth, mouth } = view.field;
  const field = useMemo<FieldView>(() => ({ center: [x, y, z], axis, halfLength, halfWidth, mouth }), [x, y, z, axis, halfLength, halfWidth, mouth]);
  const ground = useGround(y);
  const playing = session.phase === 'playing';
  useKickKey(playing && !!me && !!view.team && view.phase === 'play', act);

  // Each kickoff once: to the spot the server gave this player, as soon as the character can be moved.
  const moved = useRef(0);
  useFrame(() => {
    const kickoff = latest.current.kickoff;
    if (!playing || !kickoff?.spot || moved.current === kickoff.n) return;
    if (teleport(kickoff.spot)) moved.current = kickoff.n;
  });

  const teamOf = useCallback((id: string): Team | null => (view.teams.a.includes(id) ? 'a' : view.teams.b.includes(id) ? 'b' : null), [view.teams]);
  return (
    <group>
      <Chalk field={field} ground={ground} color={colors.line} />
      <Goals field={field} colors={colors} />
      <Ball view={latest} ground={ground} serverNow={serverNow} color={colors.line} />
      {session.players.map((player) => {
        const team = teamOf(player.id);
        if (!team) return null;
        const mine = player.id === session.you;
        const where = mine ? () => standing(playerRef?.current) : () => (player.peer ? (live?.get(player.peer)?.position ?? null) : null);
        return <Ring key={player.id} where={where} ground={ground} color={colors[team]} smooth={!mine} />;
      })}
    </group>
  );
}
