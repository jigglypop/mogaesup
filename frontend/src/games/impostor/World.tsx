import { useMemo, useRef } from 'react';

import { useFrame } from '@react-three/fiber';
import type { Mesh } from 'three';

import type { GameProps } from '../game';
import type { Vec3 } from '../protocol';
import type { ImpostorView } from './index';
import { useImpostorSync } from './sync';

/** Markers are left out of picking, so a click on one walks to the ground under it. */
const noRaycast = () => null;
/** A pad's radius, and how high the marker over one of the viewer's own floats, in meters. */
const PAD = 0.8;
const MARK = 1.9;

/** A colour token from tokens.css, for materials the stylesheet cannot reach. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Turns and bobs over a station the viewer still has to work at, to find it from afar. */
function Marker({ at, color }: { at: Vec3; color: string }) {
  const mesh = useRef<Mesh>(null);
  useFrame(({ clock: time }) => {
    const marker = mesh.current;
    if (!marker) return;
    marker.rotation.y = time.elapsedTime * 1.4;
    marker.position.y = at[1] + MARK + Math.sin(time.elapsedTime * 2.2) * 0.1;
  });
  return (
    <mesh ref={mesh} position={[at[0], at[1] + MARK, at[2]]} rotation={[Math.PI, 0, 0]} raycast={noRaycast}>
      <coneGeometry args={[0.24, 0.48, 4]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} roughness={0.4} />
    </mesh>
  );
}

function Pad({ at, color, lit }: { at: Vec3; color: string; lit: boolean }) {
  return (
    <mesh position={[at[0], at[1] + 0.03, at[2]]} raycast={noRaycast}>
      <cylinderGeometry args={[PAD, PAD, 0.06, 32]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={lit ? 0.45 : 0} transparent opacity={lit ? 0.95 : 0.6} />
    </mesh>
  );
}

/** The meeting table: a round top on a post, glowing while a meeting is on. */
function Table({ at, color, glow }: { at: Vec3; color: string; glow: string | null }) {
  return (
    <group position={at}>
      <mesh position={[0, 0.38, 0]} raycast={noRaycast}>
        <cylinderGeometry args={[0.12, 0.2, 0.76, 12]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.8, 0]} raycast={noRaycast}>
        <cylinderGeometry args={[0.95, 0.95, 0.08, 40]} />
        <meshStandardMaterial color={color} emissive={glow ?? color} emissiveIntensity={glow ? 0.5 : 0} roughness={0.6} />
      </mesh>
    </group>
  );
}

/** Someone lying where they fell. */
function Body({ at, color }: { at: Vec3; color: string }) {
  return (
    <mesh position={[at[0], at[1] + 0.22, at[2]]} rotation={[0, 0, Math.PI / 2]} raycast={noRaycast}>
      <capsuleGeometry args={[0.22, 0.7, 4, 12]} />
      <meshStandardMaterial color={color} roughness={0.6} />
    </mesh>
  );
}

/** The stations (the viewer's unfinished ones lit and marked), the table, and the bodies on the ground. */
export function ImpostorWorld(props: GameProps<ImpostorView>) {
  useImpostorSync(props);
  const { view } = props;
  const colors = useMemo(
    () => ({ pad: token('--mg-impostor-pad'), task: token('--mg-impostor-task'), table: token('--mg-impostor-table'), body: token('--mg-impostor-body') }),
    [],
  );
  const mine = new Set(view.phase === 'ended' ? [] : view.tasks.filter((task) => !task.done).map((task) => task.station));
  // Bodies lie on the island's ground, where the table stands.
  const ground = view.table[1];
  return (
    <group>
      {view.stations.map((at, index) => (
        <group key={index}>
          <Pad at={at} color={mine.has(index) ? colors.task : colors.pad} lit={mine.has(index)} />
          {mine.has(index) && <Marker at={at} color={colors.task} />}
        </group>
      ))}
      <Table at={view.table} color={colors.table} glow={view.meeting ? colors.task : null} />
      {view.bodies.map((body) => (
        <Body key={body.id} at={[body.position[0], ground, body.position[2]]} color={colors.body} />
      ))}
    </group>
  );
}
