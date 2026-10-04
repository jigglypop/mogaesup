import { useMemo, useRef } from 'react';

import { useFrame } from '@react-three/fiber';
import type { Mesh } from 'three';

import type { GameProps } from '../game';
import type { Vec3 } from '../protocol';
import type { TreasureView } from './index';

/** How high a gem floats over its spot, in meters. */
const HOVER = 0.9;
/** Gems are left out of picking, so a click on one walks to the ground under it. */
const noRaycast = () => null;

/** A colour token from tokens.css, for materials the stylesheet cannot reach. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function Gem({ id, position, gold, color }: { id: number; position: Vec3; gold: boolean; color: string }) {
  const mesh = useRef<Mesh>(null);
  // Each gem turns and bobs on its own beat.
  const offset = (id * 2.399) % (Math.PI * 2);
  useFrame(({ clock: time }) => {
    const gem = mesh.current;
    if (!gem) return;
    const t = time.elapsedTime + offset;
    gem.rotation.y = t * 1.6;
    gem.position.y = position[1] + HOVER + Math.sin(t * 2.4) * 0.08;
  });
  return (
    <mesh ref={mesh} position={[position[0], position[1] + HOVER, position[2]]} raycast={noRaycast}>
      <octahedronGeometry args={[gold ? 0.44 : 0.32, 0]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={gold ? 0.7 : 0.5} roughness={0.3} metalness={0.1} />
    </mesh>
  );
}

/** The gems out now, small and glowing over their spots; gold ones larger and gold. */
export function TreasureWorld({ view }: GameProps<TreasureView>) {
  const colors = useMemo(() => ({ gem: token('--mg-gem'), gold: token('--mg-gem-gold') }), []);
  return (
    <group>
      {view.gems.map((gem) => (
        <Gem key={gem.id} id={gem.id} position={gem.position} gold={gem.value > 1} color={gem.value > 1 ? colors.gold : colors.gem} />
      ))}
    </group>
  );
}
