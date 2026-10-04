import { useEffect, useMemo, useRef } from 'react';

import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';

import type { GameProps } from '../game';
import type { Vec3 } from '../protocol';
import type { RedlightPhase, RedlightView } from './index';

/** Lines and the marker are left out of picking, so a click on them walks to the ground under them. */
const noRaycast = () => null;
/** How wide the lines across the track are drawn (the players' line is at most 8 m) and how deep, in meters. */
const LINE_WIDTH = 9;
const LINE_DEPTH = 0.3;
/** How high over the ground point the lines lie, clear of the ground's own unevenness, and how tall their end posts are. */
const LINE_LIFT = 0.1;
const POST = 1.1;
/** How far past the finish line the marker stands. */
const MARKER_BACK = 1.2;
/** How quickly the marker's head turns, per second. */
const TURN = 9;

/** A colour token from tokens.css, for materials the stylesheet cannot reach. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Puts the viewer's character at `ground` once for each new place there (trying again until the island's world can),
 * for as long as the view has one.
 */
export function useArrive(ground: Vec3 | null | undefined, teleport: (ground: Vec3) => boolean) {
  const key = ground ? ground.join(',') : '';
  useEffect(() => {
    if (!key) return undefined;
    const place = key.split(',').map(Number) as Vec3;
    if (teleport(place)) return undefined;
    const retry = setInterval(() => {
      if (teleport(place)) clearInterval(retry);
    }, 250);
    return () => clearInterval(retry);
  }, [key, teleport]);
}

/** A thin strip across the track at `at`, in the light's colour, with a post at each end that stands above tall grass. */
function Line({ at, facing, color }: { at: Vec3; facing: number; color: string }) {
  return (
    <group position={at} rotation={[0, facing, 0]}>
      <mesh position={[0, LINE_LIFT, 0]} raycast={noRaycast}>
        <boxGeometry args={[LINE_WIDTH, 0.03, LINE_DEPTH]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.45} roughness={0.6} />
      </mesh>
      {[-LINE_WIDTH / 2, LINE_WIDTH / 2].map((x) => (
        <mesh key={x} position={[x, POST / 2, 0]} raycast={noRaycast} castShadow>
          <cylinderGeometry args={[0.07, 0.09, POST, 12]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.45} roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

type MarkerColors = { body: string; eye: string; light: string };

/** The tall one at the finish: its back to the players on green, its face to them on red, its lamp in the light's colour. */
function Marker({ at, facing, watching, colors }: { at: Vec3; facing: number; watching: boolean; colors: MarkerColors }) {
  const head = useRef<Group>(null);
  useFrame((_, delta) => {
    const turned = head.current;
    if (!turned) return;
    const toward = watching ? Math.PI : 0;
    turned.rotation.y += (toward - turned.rotation.y) * Math.min(1, delta * TURN);
  });
  return (
    <group position={at} rotation={[0, facing, 0]}>
      <mesh position={[0, 1.1, 0]} raycast={noRaycast} castShadow>
        <cylinderGeometry args={[0.3, 0.5, 2.2, 20]} />
        <meshStandardMaterial color={colors.body} roughness={0.7} />
      </mesh>
      {/* The face looks along +z, away from the players, until the head turns. */}
      <group ref={head} position={[0, 2.6, 0]}>
        <mesh raycast={noRaycast} castShadow>
          <sphereGeometry args={[0.45, 24, 16]} />
          <meshStandardMaterial color={colors.body} roughness={0.6} />
        </mesh>
        {[-0.16, 0.16].map((x) => (
          <mesh key={x} position={[x, 0.06, 0.4]} raycast={noRaycast}>
            <sphereGeometry args={[0.07, 12, 8]} />
            <meshStandardMaterial color={colors.eye} roughness={0.4} />
          </mesh>
        ))}
      </group>
      <mesh position={[0, 3.3, 0]} rotation={[Math.PI / 2, 0, 0]} raycast={noRaycast}>
        <torusGeometry args={[0.32, 0.08, 12, 32]} />
        <meshStandardMaterial color={colors.light} emissive={colors.light} emissiveIntensity={0.9} />
      </mesh>
    </group>
  );
}

/** The start and finish lines across the track and the marker past the finish; the viewer goes to their place in 준비. */
export function RedlightWorld({ view, teleport }: GameProps<RedlightView>) {
  useArrive(view.slot, teleport);
  const colors = useMemo(
    () => ({
      lights: { ready: token('--mg-redlight-wait'), green: token('--mg-redlight-go'), red: token('--mg-redlight-stop') } as Record<RedlightPhase, string>,
      body: token('--mg-redlight-marker'),
      eye: token('--mg-redlight-eye'),
    }),
    [],
  );
  const { start, finish } = view.track;
  const [dx, dz] = [finish[0] - start[0], finish[2] - start[2]];
  const length = Math.hypot(dx, dz) || 1;
  // Turns local +z toward the finish.
  const facing = Math.atan2(dx, dz);
  const light = colors.lights[view.phase];
  const marker: Vec3 = [finish[0] + (dx / length) * MARKER_BACK, finish[1], finish[2] + (dz / length) * MARKER_BACK];
  return (
    <group>
      <Line at={start} facing={facing} color={light} />
      <Line at={finish} facing={facing} color={light} />
      <Marker at={marker} facing={facing} watching={view.phase === 'red'} colors={{ body: colors.body, eye: colors.eye, light }} />
    </group>
  );
}
