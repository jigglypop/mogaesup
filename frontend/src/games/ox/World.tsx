import { useMemo, useRef } from 'react';

import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';

import type { GameProps } from '../game';
import type { Vec3 } from '../protocol';
import type { OxView, OxZone } from './index';

/** Markers are left out of picking, so a click on one walks to the ground under it. */
const noRaycast = () => null;
/** Just over the ground (grass tiles sit 5 cm up), so the markers do not flicker into it. */
const LIFT = 0.08;
/** Lying on the ground. */
const FLAT = -Math.PI / 2;

/** A colour token from tokens.css, for materials the stylesheet cannot reach. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** While a statement is asked both zones look alike; while its answer shows the right one glows and the other fades. */
type Look = 'asking' | 'right' | 'wrong';

function Zone({ zone, at, radius, color, look }: { zone: OxZone; at: Vec3; radius: number; color: string; look: Look }) {
  const mark = useRef<Group>(null);
  useFrame(({ clock: time }) => {
    const group = mark.current;
    if (!group) return;
    const scale = look === 'right' ? 1 + Math.sin(time.elapsedTime * 6) * 0.05 : 1;
    group.scale.set(scale, 1, scale);
  });
  const area = look === 'right' ? 0.34 : look === 'wrong' ? 0.06 : 0.16;
  const solid = look === 'wrong' ? 0.3 : 1;
  const glow = look === 'right' ? 0.9 : look === 'wrong' ? 0 : 0.3;
  const material = <meshStandardMaterial color={color} emissive={color} emissiveIntensity={glow} roughness={0.5} transparent opacity={solid} />;
  return (
    <group position={[at[0], at[1] + LIFT, at[2]]}>
      {/* The ground that counts: a disc and its rim. */}
      <mesh rotation-x={FLAT} raycast={noRaycast}>
        <circleGeometry args={[radius, 64]} />
        <meshBasicMaterial color={color} transparent opacity={area} depthWrite={false} />
      </mesh>
      <mesh rotation-x={FLAT} position-y={0.01} raycast={noRaycast}>
        <ringGeometry args={[radius - 0.2, radius, 64]} />
        <meshBasicMaterial color={color} transparent opacity={solid * 0.85} depthWrite={false} />
      </mesh>
      {/* The big O ring, or the big X of two crossed bars. */}
      <group ref={mark}>
        {zone === 'o' ? (
          <mesh rotation-x={FLAT} position-y={0.3} raycast={noRaycast}>
            <torusGeometry args={[radius * 0.52, 0.3, 12, 64]} />
            {material}
          </mesh>
        ) : (
          [1, -1].map((side) => (
            <mesh key={side} rotation-y={(side * Math.PI) / 4} position-y={0.14} raycast={noRaycast}>
              <boxGeometry args={[radius * 1.45, 0.24, 0.6]} />
              {material}
            </mesh>
          ))
        )}
      </group>
    </group>
  );
}

/** The O and X zones on the island's ground while the game plays. */
export function OxWorld({ view, session }: GameProps<OxView>) {
  const colors = useMemo(() => ({ o: token('--mg-ox-o'), x: token('--mg-ox-x') }), []);
  if (session.phase !== 'playing') return null;
  const look = (zone: OxZone): Look => (view.phase !== 'answer' || !view.answer ? 'asking' : view.answer === zone ? 'right' : 'wrong');
  return (
    <group>
      {(['o', 'x'] as const).map((zone) => (
        <Zone key={zone} zone={zone} at={view.zones[zone]} radius={view.zones.radius} color={colors[zone]} look={look(zone)} />
      ))}
    </group>
  );
}
