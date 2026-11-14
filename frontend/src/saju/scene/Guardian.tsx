import { useRef, type ReactNode } from 'react';

import type { Group } from 'three';

import type { Element } from '../elements';
import type { Animal, Charm, Guardian as GuardianSpec } from '../profile';
import { At, Ball, Box, Cone, Cyl, Ring, seeded, type V3 } from './kit';
import { Hover, useAnimation } from './parts';
import { MOVING, Static } from './Static';

// 수호 캐릭터: the day branch's animal, in the colour of the day stem's element, wearing what the chart's 신살 gave it.
// One small round body carries twelve heads and tails. It is drawn facing +z, about its feet.

type Coat = { main: string; light: string; dark: string };
/** 오방색 as fur: 푸른, 붉은, 노란, 하얀, 검은. */
const COATS: Record<Element, Coat> = {
  wood: { main: '#5fbf9f', light: '#cdf2e0', dark: '#2f8a70' },
  fire: { main: '#f0715e', light: '#ffdccf', dark: '#bf4733' },
  earth: { main: '#f3c552', light: '#fff2c7', dark: '#c58f1f' },
  metal: { main: '#f4f1ea', light: '#ffffff', dark: '#c3c8d4' },
  water: { main: '#4d577d', light: '#aeb9dc', dark: '#2f3556' },
};
const INK = '#2b2a36';
const PINK = '#ff9fb0';
const GOLD = '#f2c55c';
const QUARTER = Math.PI / 2;
const HEAD: V3 = [0, 1.28, 0.08];
const BLINK_EVERY = 3.6;

const gold = { metal: 0.7, rough: 0.3 } as const;
const mirrored = [-1, 1] as const;

/** What sits on the round head, about its middle. */
const HEADS: Record<Animal, (coat: Coat) => ReactNode> = {
  rat: (c) => (
    <>
      {mirrored.map((side) => (
        <group key={side}>
          <Cyl radius={0.21} height={0.05} sides={16} position={[side * 0.37, 0.4, -0.03]} rotation={[QUARTER, 0, 0]} color={c.main} />
          <Cyl radius={0.14} height={0.06} sides={16} position={[side * 0.37, 0.4, -0.02]} rotation={[QUARTER, 0, 0]} color={PINK} />
        </group>
      ))}
      <Ball radius={0.15} scale={[1.1, 0.8, 1]} position={[0, -0.1, 0.38]} color={c.light} />
      <Ball radius={0.05} position={[0, -0.05, 0.53]} color={PINK} />
      <Box size={[0.08, 0.07, 0.03]} position={[0, -0.2, 0.46]} color="#ffffff" />
    </>
  ),
  ox: (c) => (
    <>
      {mirrored.map((side) => (
        <group key={side}>
          <Cone radius={0.085} height={0.32} sides={8} position={[side * 0.31, 0.44, 0]} rotation={[0, 0, side * -0.6]} color="#fff3d6" />
          <Ball radius={0.12} scale={[1.5, 0.6, 0.5]} position={[side * 0.5, 0.2, 0]} color={c.main} />
          <Ball radius={0.03} position={[side * 0.09, -0.12, 0.5]} color={INK} />
        </group>
      ))}
      <Ball radius={0.25} scale={[1.25, 0.78, 0.8]} position={[0, -0.14, 0.3]} color={c.light} />
      <Ring radius={0.07} tube={0.017} position={[0, -0.27, 0.47]} color={GOLD} {...gold} />
    </>
  ),
  tiger: (c) => (
    <>
      {mirrored.map((side) => (
        <group key={side}>
          <Ball radius={0.13} position={[side * 0.31, 0.38, -0.02]} color={c.main} />
          <Ball radius={0.07} position={[side * 0.31, 0.38, 0.06]} color={c.light} />
          <Box size={[0.05, 0.15, 0.04]} position={[side * 0.13, 0.32, 0.3]} rotation={[-0.7, 0, side * -0.25]} color={c.dark} />
          <Box size={[0.15, 0.045, 0.04]} position={[side * 0.41, 0.02, 0.2]} rotation={[0, side * 0.6, 0]} color={c.dark} />
          <Box size={[0.13, 0.045, 0.04]} position={[side * 0.4, -0.1, 0.22]} rotation={[0, side * 0.6, 0]} color={c.dark} />
        </group>
      ))}
      <Box size={[0.05, 0.17, 0.04]} position={[0, 0.34, 0.31]} rotation={[-0.7, 0, 0]} color={c.dark} />
      <Ball radius={0.19} scale={[1.25, 0.8, 0.7]} position={[0, -0.12, 0.34]} color={c.light} />
      <Ball radius={0.05} position={[0, -0.05, 0.5]} color="#e2707a" />
    </>
  ),
  rabbit: (c) => (
    <>
      {mirrored.map((side) => (
        <group key={side}>
          <Ball radius={0.12} scale={[1, 3.1, 0.6]} position={[side * 0.17, 0.72, -0.03]} rotation={[0, 0, side * -0.14]} color={c.main} />
          <Ball radius={0.07} scale={[1, 3.4, 0.4]} position={[side * 0.17, 0.72, 0.03]} rotation={[0, 0, side * -0.14]} color={PINK} />
        </group>
      ))}
      <Ball radius={0.13} scale={[1.2, 0.8, 0.8]} position={[0, -0.12, 0.37]} color={c.light} />
      <Ball radius={0.04} position={[0, -0.07, 0.48]} color={PINK} />
      <Box size={[0.08, 0.07, 0.03]} position={[0, -0.21, 0.44]} color="#ffffff" />
    </>
  ),
  dragon: (c) => (
    <>
      {mirrored.map((side) => (
        <group key={side}>
          <Cyl radius={0.045} top={0.02} height={0.4} sides={6} position={[side * 0.22, 0.52, -0.05]} rotation={[0, 0, side * -0.4]} color={GOLD} {...gold} />
          <Cyl radius={0.03} top={0.015} height={0.18} sides={6} position={[side * 0.33, 0.56, -0.05]} rotation={[0, 0, side * -1.15]} color={GOLD} {...gold} />
          <Cone radius={0.09} height={0.22} sides={5} position={[side * 0.44, 0.14, -0.06]} rotation={[0, 0, side * -1.2]} color={c.dark} />
          <Cyl radius={0.015} height={0.36} sides={5} position={[side * 0.3, -0.2, 0.44]} rotation={[0, 0, side * 0.95]} color={GOLD} {...gold} />
          <Ball radius={0.03} position={[side * 0.07, -0.05, 0.58]} color={INK} />
        </group>
      ))}
      <Ball radius={0.22} scale={[1.05, 0.72, 1.15]} position={[0, -0.12, 0.34]} color={c.light} />
      <Cone radius={0.09} height={0.24} sides={5} position={[0, 0.45, -0.12]} rotation={[-0.35, 0, 0]} color={c.dark} />
      <Cone radius={0.09} height={0.22} sides={5} position={[0, 0.3, -0.37]} rotation={[-1.05, 0, 0]} color={c.dark} />
    </>
  ),
  snake: (c) => (
    <>
      <Ball radius={0.12} scale={[1.4, 0.5, 1]} position={[0, 0.38, 0.05]} color={c.dark} />
      <Ball radius={0.14} scale={[1.2, 0.7, 0.9]} position={[0, -0.14, 0.33]} color={c.light} />
      <Box size={[0.035, 0.02, 0.24]} position={[0, -0.16, 0.52]} color="#e2574c" />
      <Box size={[0.03, 0.02, 0.1]} position={[-0.035, -0.16, 0.67]} rotation={[0, -0.5, 0]} color="#e2574c" />
      <Box size={[0.03, 0.02, 0.1]} position={[0.035, -0.16, 0.67]} rotation={[0, 0.5, 0]} color="#e2574c" />
    </>
  ),
  horse: (c) => (
    <>
      {mirrored.map((side) => (
        <group key={side}>
          <Cone radius={0.085} height={0.26} sides={6} position={[side * 0.21, 0.48, -0.02]} color={c.main} />
          <Ball radius={0.03} position={[side * 0.07, -0.1, 0.65]} color={INK} />
        </group>
      ))}
      <Ball radius={0.23} scale={[0.9, 0.85, 1.35]} position={[0, -0.13, 0.36]} color={c.light} />
      <Ball radius={0.11} position={[0, 0.36, 0.3]} color={c.dark} />
      {([[0.47, 0.06], [0.42, -0.15], [0.26, -0.34], [0.03, -0.42], [-0.2, -0.42]] as const).map(([y, z]) => (
        <Ball key={y} radius={0.14} position={[0, y, z]} color={c.dark} />
      ))}
    </>
  ),
  sheep: (c) => (
    <>
      {([[0, 0.42, 0.04], [-0.25, 0.35, 0.06], [0.25, 0.35, 0.06], [-0.14, 0.38, -0.2], [0.14, 0.38, -0.2], [0, 0.26, -0.34], [-0.36, 0.18, -0.2], [0.36, 0.18, -0.2]] as const).map(
        ([x, y, z]) => <Ball key={`${x}${y}${z}`} radius={0.2} position={[x, y, z]} color={c.main} />,
      )}
      {mirrored.map((side) => (
        <group key={side}>
          <Ball radius={0.11} scale={[1.6, 0.55, 0.6]} position={[side * 0.5, 0.03, 0.08]} rotation={[0, 0, side * -0.5]} color={c.light} />
          <Ring radius={0.13} tube={0.045} arc={4.6} position={[side * 0.42, 0.2, -0.04]} rotation={[0, side * QUARTER, 0]} color="#e8d9b0" />
        </group>
      ))}
      <Ball radius={0.16} scale={[1.1, 0.8, 0.8]} position={[0, -0.14, 0.36]} color="#fff7ea" />
      <Ball radius={0.04} position={[0, -0.08, 0.5]} color={PINK} />
    </>
  ),
  monkey: (c) => (
    <>
      {mirrored.map((side) => (
        <group key={side}>
          <Cyl radius={0.18} height={0.06} sides={14} position={[side * 0.5, 0.02, 0]} rotation={[QUARTER, 0, 0]} color={c.main} />
          <Cyl radius={0.11} height={0.07} sides={14} position={[side * 0.5, 0.02, 0.01]} rotation={[QUARTER, 0, 0]} color={c.light} />
          <Ball radius={0.2} scale={[1, 1, 0.4]} position={[side * 0.15, 0.06, 0.33]} color={c.light} />
        </group>
      ))}
      <Ball radius={0.2} scale={[1.2, 0.85, 0.7]} position={[0, -0.16, 0.35]} color={c.light} />
      <Ball radius={0.03} position={[0, -0.08, 0.5]} color={INK} />
      <Ball radius={0.1} position={[0, 0.46, 0.06]} color={c.dark} />
    </>
  ),
  rooster: () => (
    <>
      <Ball radius={0.1} position={[0, 0.5, 0.15]} color="#e23d3d" />
      <Ball radius={0.13} position={[0, 0.56, 0]} color="#e23d3d" />
      <Ball radius={0.1} position={[0, 0.5, -0.15]} color="#e23d3d" />
      <Cone radius={0.09} height={0.22} sides={6} position={[0, -0.06, 0.53]} rotation={[QUARTER, 0, 0]} color="#f2a93b" />
      {mirrored.map((side) => (
        <Ball key={side} radius={0.07} scale={[0.8, 1.4, 0.8]} position={[side * 0.06, -0.25, 0.41]} color="#e23d3d" />
      ))}
    </>
  ),
  dog: (c) => (
    <>
      {mirrored.map((side) => (
        <Ball key={side} radius={0.17} scale={[0.6, 1.5, 0.9]} position={[side * 0.44, 0.08, -0.02]} rotation={[0, 0, side * 0.2]} color={c.dark} />
      ))}
      <Ball radius={0.15} scale={[1, 1, 0.3]} position={[0.17, 0.06, 0.37]} color={c.dark} />
      <Ball radius={0.21} scale={[1.15, 0.82, 0.9]} position={[0, -0.14, 0.32]} color={c.light} />
      <Ball radius={0.065} position={[0, -0.06, 0.53]} color={INK} />
      <Ball radius={0.06} scale={[1, 0.4, 1.3]} position={[0, -0.28, 0.42]} color={PINK} />
    </>
  ),
  pig: (c) => (
    <>
      {mirrored.map((side) => (
        <group key={side}>
          <Cone radius={0.14} height={0.24} sides={4} position={[side * 0.29, 0.42, 0.05]} rotation={[0.6, 0, side * -0.3]} color={c.dark} />
          <Ball radius={0.035} position={[side * 0.06, -0.1, 0.51]} color={INK} />
        </group>
      ))}
      <Cyl radius={0.17} height={0.12} sides={14} position={[0, -0.1, 0.44]} rotation={[QUARTER, 0, 0]} color={c.light} />
    </>
  ),
};

/** What an animal has behind it; it wags about the root of the tail. */
const TAILS: Record<Animal, (coat: Coat) => ReactNode> = {
  rat: () => <Ring radius={0.3} tube={0.03} arc={3.4} position={[0.12, 0.3, -0.2]} rotation={[0, QUARTER, 0.3]} color="#f4b3a8" />,
  ox: (c) => (
    <>
      <Cyl radius={0.035} height={0.5} sides={6} position={[0, 0.08, -0.16]} rotation={[0.9, 0, 0]} color={c.dark} />
      <Ball radius={0.09} position={[0, -0.08, -0.36]} color={c.dark} />
    </>
  ),
  tiger: (c) => (
    <>
      {([[0.02, 0, -0.08, 0.1], [0.1, 0.14, -0.2, 0.095], [0.15, 0.32, -0.25, 0.09], [0.16, 0.5, -0.22, 0.085], [0.13, 0.66, -0.14, 0.08]] as const).map(([x, y, z, radius], index) => (
        <Ball key={index} radius={radius} position={[x, y, z]} color={index % 2 ? c.dark : c.main} />
      ))}
    </>
  ),
  rabbit: () => <Ball radius={0.16} position={[0, 0, -0.04]} color="#ffffff" />,
  dragon: (c) => (
    <>
      {([[0, 0, -0.1, 0.2], [0.22, -0.05, -0.34, 0.16], [0.48, -0.03, -0.46, 0.12], [0.7, 0.07, -0.44, 0.09]] as const).map(([x, y, z, radius]) => (
        <Ball key={x} radius={radius} position={[x, y, z]} color={c.main} />
      ))}
      <Cone radius={0.1} height={0.26} sides={5} position={[0.86, 0.2, -0.4]} rotation={[0, 0, -0.9]} color={GOLD} {...gold} />
    </>
  ),
  snake: (c) => <Cone radius={0.11} height={0.34} sides={8} position={[0.72, -0.14, 0.36]} rotation={[QUARTER, 0, -0.9]} color={c.main} />,
  horse: (c) => <Ball radius={0.16} scale={[0.7, 1.9, 0.7]} position={[0, 0.02, -0.12]} rotation={[0.5, 0, 0]} color={c.dark} />,
  sheep: (c) => <Ball radius={0.15} position={[0, 0.05, -0.08]} color={c.main} />,
  monkey: (c) => <Ring radius={0.26} tube={0.05} arc={4.4} position={[0.3, 0.2, -0.08]} rotation={[0, QUARTER, 0.4]} color={c.main} />,
  rooster: (c) => (
    <>
      <Ball radius={0.22} scale={[0.35, 1.8, 0.7]} position={[0, 0.5, -0.14]} rotation={[-0.55, 0, 0]} color="#2f8a70" />
      <Ball radius={0.2} scale={[0.35, 1.7, 0.7]} position={[-0.16, 0.4, -0.1]} rotation={[-0.55, 0, 0.35]} color={GOLD} />
      <Ball radius={0.2} scale={[0.35, 1.7, 0.7]} position={[0.16, 0.4, -0.1]} rotation={[-0.55, 0, -0.35]} color={c.dark} />
    </>
  ),
  dog: (c) => <Cone radius={0.09} height={0.5} sides={8} position={[0, 0.2, -0.1]} rotation={[-0.7, 0, 0]} color={c.main} />,
  pig: () => <Ring radius={0.09} tube={0.03} arc={5.2} position={[0, 0.08, -0.06]} rotation={[0, QUARTER, 0]} color={PINK} />,
};

/** The round body every animal but the snake stands on. */
function Body({ animal, coat }: { animal: Animal; coat: Coat }) {
  if (animal === 'snake') {
    return (
      <>
        <Ring radius={0.46} tube={0.2} position={[0, 0.2, 0]} rotation={[QUARTER, 0, 0]} color={coat.main} />
        <Ring radius={0.34} tube={0.18} position={[0, 0.52, 0]} rotation={[QUARTER, 0, 0]} color={coat.main} />
        <Cyl radius={0.2} top={0.17} height={0.6} sides={12} position={[0, 0.95, 0.04]} color={coat.main} />
        <Ball radius={0.12} scale={[1, 1.9, 0.5]} position={[0, 0.95, 0.19]} color={coat.light} />
      </>
    );
  }
  const hooved = animal === 'ox' || animal === 'horse' || animal === 'sheep' || animal === 'pig';
  const feet = animal === 'rooster' ? '#f2a93b' : hooved ? coat.dark : coat.main;
  const wool = animal === 'sheep';
  return (
    <>
      <Ball radius={0.5} scale={[animal === 'pig' ? 1.1 : 1, 0.95, 0.9]} position={[0, 0.55, 0]} color={coat.main} />
      {wool
        ? Array.from({ length: 9 }, (_, index) => {
            const angle = (index / 9) * Math.PI * 2;
            return <Ball key={index} radius={0.22} position={[Math.cos(angle) * 0.4, 0.5 + seeded(index) * 0.25, Math.sin(angle) * 0.36]} color={coat.main} />;
          })
        : <Ball radius={0.34} position={[0, 0.47, 0.17]} color={coat.light} />}
      {mirrored.map((side) => (
        <group key={side}>
          <Ball radius={0.16} scale={[1, 0.6, 1.25]} position={[side * 0.24, 0.09, 0.26]} color={feet} />
          {animal === 'rooster' ? (
            <Ball radius={0.3} scale={[0.4, 0.95, 1.15]} position={[side * 0.48, 0.58, -0.02]} color={coat.dark} />
          ) : (
            <Ball radius={0.13} scale={[0.9, 1.3, 0.9]} position={[side * 0.47, 0.66, 0.14]} color={wool ? coat.light : coat.main} />
          )}
        </group>
      ))}
      {animal === 'dragon' &&
        ([[1.0, -0.42, -1.1], [0.72, -0.5, -1.3], [0.45, -0.5, -1.5]] as const).map(([y, z, tilt]) => (
          <Cone key={y} radius={0.09} height={0.2} sides={5} position={[0, y, z]} rotation={[tilt, 0, 0]} color={coat.dark} />
        ))}
      {animal === 'dragon' && (
        <Hover position={[0.62, 0.95, 0.42]} height={0.06} speed={2}>
          <Ball radius={0.13} color="#fff3c4" emissive="#ffe27a" glow={1.4} />
        </Hover>
      )}
      {animal === 'dog' && <Ring radius={0.34} tube={0.05} position={[0, 0.98, 0.03]} rotation={[QUARTER, 0, 0]} color="#e2574c" />}
      {animal === 'dog' && <Ball radius={0.055} position={[0, 0.92, 0.36]} color={GOLD} {...gold} />}
      {animal === 'ox' && <Ball radius={0.2} scale={[1, 0.9, 0.3]} position={[0.3, 0.72, 0.3]} color={coat.dark} />}
    </>
  );
}

/** What the 신살 gave, each in its own place on or beside the guardian. */
const CHARMS: Record<Charm, () => ReactNode> = {
  star: () => (
    <Hover position={[0, 2.12, 0.05]} height={0.06} speed={2} spin={1.2}>
      <Cone radius={0.2} height={0.3} sides={4} position={[0, 0.15, 0]} color="#ffe27a" emissive="#ffc93c" glow={1.3} />
      <Cone radius={0.2} height={0.3} sides={4} position={[0, -0.15, 0]} rotation={[Math.PI, 0, 0]} color="#ffe27a" emissive="#ffc93c" glow={1.3} />
    </Hover>
  ),
  canopy: () => (
    <Hover position={[0, 2.22, 0]} height={0.05} speed={1.3} spin={0.4}>
      <Cone radius={0.66} height={0.26} sides={10} position={[0, 0.13, 0]} color="#c9a0ff" />
      <Ring radius={0.64} tube={0.03} position={[0, 0, 0]} rotation={[QUARTER, 0, 0]} color={GOLD} {...gold} />
      <Ball radius={0.06} position={[0, 0.29, 0]} color={GOLD} {...gold} />
      {Array.from({ length: 5 }, (_, index) => (
        <Ball key={index} radius={0.05} position={[Math.cos(index * 1.257) * 0.62, -0.09, Math.sin(index * 1.257) * 0.62]} color="#ff9fc0" />
      ))}
    </Hover>
  ),
  blossom: () => (
    <At position={[0.31, 1.69, 0.3]} rotation={[-0.3, 0.4, 0]}>
      {Array.from({ length: 5 }, (_, index) => (
        <Ball key={index} radius={0.075} scale={[1, 1, 0.5]} position={[Math.cos(index * 1.257) * 0.09, Math.sin(index * 1.257) * 0.09, 0]} color="#ffb7d0" />
      ))}
      <Ball radius={0.05} position={[0, 0, 0.03]} color="#ffe27a" />
    </At>
  ),
  cape: () => (
    <>
      <Box size={[0.98, 0.92, 0.05]} position={[0, 0.68, -0.48]} rotation={[0.22, 0, 0]} color="#2f3566" />
      {([[-0.25, 0.9], [0.2, 0.75], [-0.05, 0.5], [0.3, 0.42], [-0.3, 0.36]] as const).map(([x, y]) => (
        <Ball key={`${x}${y}`} radius={0.035} position={[x, y, -0.52 - (0.9 - y) * 0.22]} color="#ffe27a" emissive="#ffc93c" glow={1.2} />
      ))}
      <Ring radius={0.36} tube={0.05} position={[0, 1, 0.02]} rotation={[QUARTER, 0, 0]} color={GOLD} {...gold} />
    </>
  ),
  ribbon: () => (
    <>
      <Cone radius={0.12} height={0.24} sides={4} position={[-0.15, 0.98, 0.43]} rotation={[0, 0, -QUARTER]} color="#e23d5a" />
      <Cone radius={0.12} height={0.24} sides={4} position={[0.15, 0.98, 0.43]} rotation={[0, 0, QUARTER]} color="#e23d5a" />
      <Ball radius={0.07} position={[0, 0.98, 0.45]} color="#c92f4b" />
    </>
  ),
  scarf: () => (
    <>
      <Ring radius={0.37} tube={0.09} position={[0, 0.99, 0.02]} rotation={[QUARTER, 0, 0]} color="#fbfbf7" />
      {[0.5, 1.4, 2.3, 3.5, 4.4, 5.4].map((angle) => (
        <Box key={angle} size={[0.05, 0.2, 0.2]} position={[Math.cos(angle) * 0.37, 0.99, 0.02 + Math.sin(angle) * 0.37]} rotation={[0, -angle, 0]} color={INK} />
      ))}
      <Box size={[0.17, 0.4, 0.06]} position={[0.22, 0.76, 0.4]} rotation={[0, 0, 0.12]} color="#fbfbf7" />
      <Box size={[0.175, 0.06, 0.065]} position={[0.23, 0.68, 0.4]} rotation={[0, 0, 0.12]} color={INK} />
    </>
  ),
  bundle: () => (
    <At position={[0.4, 0.95, -0.12]} rotation={[-0.75, 0, -0.2]}>
      <Cyl radius={0.03} height={1.5} sides={6} position={[0, 0.4, 0]} color="#8f5f3c" />
      <Ball radius={0.25} scale={[1, 0.9, 1]} position={[0, 1.02, 0]} color="#7fb6e8" />
      <Ball radius={0.07} position={[0.08, 1.25, 0.04]} color="#7fb6e8" />
      <Ball radius={0.07} position={[-0.08, 1.25, -0.04]} color="#7fb6e8" />
      {([[0.2, 1.05, 0.12], [-0.16, 0.92, 0.17], [0.02, 0.86, -0.22]] as const).map(([x, y, z]) => (
        <Ball key={`${x}${y}`} radius={0.045} position={[x, y, z]} color="#ffffff" />
      ))}
    </At>
  ),
  flag: () => (
    <>
      <Cyl radius={0.025} height={1.75} sides={6} position={[-0.46, 0.95, -0.32]} color="#8f5f3c" />
      <Ball radius={0.05} position={[-0.46, 1.85, -0.32]} color={GOLD} {...gold} />
      <Box size={[0.55, 0.36, 0.02]} position={[-0.17, 1.6, -0.32]} color="#e23d3d" twoSided />
      <Box size={[0.55, 0.05, 0.025]} position={[-0.17, 1.76, -0.32]} color={GOLD} />
    </>
  ),
  books: () => (
    <At position={[0.98, 0, 0.18]}>
      <Box size={[0.5, 0.12, 0.38]} position={[0, 0.06, 0]} color="#e2674f" />
      <Box size={[0.46, 0.1, 0.34]} position={[0.01, 0.17, 0]} rotation={[0, 0.3, 0]} color="#5a9be0" />
      <Box size={[0.4, 0.09, 0.3]} position={[0, 0.265, 0]} rotation={[0, -0.2, 0]} color="#6fbf6a" />
      <Cyl radius={0.1} height={0.22} sides={10} position={[-0.08, 0.11, -0.4]} color="#f3e6cf" />
      <Cyl radius={0.015} height={0.36} sides={5} position={[-0.11, 0.3, -0.4]} rotation={[0, 0, 0.2]} color="#8f5f3c" />
      <Cyl radius={0.015} height={0.36} sides={5} position={[-0.04, 0.3, -0.38]} rotation={[0.2, 0, -0.2]} color={INK} />
    </At>
  ),
  sword: () => (
    <At position={[0.98, 0, 0.12]} rotation={[0, 0, -0.14]}>
      <Box size={[0.09, 0.85, 0.028]} position={[0, 0.5, 0]} color="#dfe6f1" metal={0.8} rough={0.25} />
      <Box size={[0.34, 0.06, 0.09]} position={[0, 0.95, 0]} color={GOLD} {...gold} />
      <Box size={[0.07, 0.22, 0.07]} position={[0, 1.08, 0]} color="#5b4636" />
      <Ball radius={0.055} position={[0, 1.21, 0]} color={GOLD} {...gold} />
    </At>
  ),
  coins: () => (
    <At position={[0.95, 0, 0.2]}>
      {[0, 1, 2, 3, 4].map((index) => (
        <Cyl key={index} radius={0.16} height={0.05} sides={14} position={[seeded(index) * 0.04, 0.025 + index * 0.052, seeded(index + 3) * 0.04]} color={GOLD} {...gold} />
      ))}
      <Cyl radius={0.16} height={0.05} sides={14} position={[0.3, 0.16, 0.08]} rotation={[0, 0.4, 1.25]} color={GOLD} {...gold} />
    </At>
  ),
};

/** What goes round a neck, and the snake's slimmer one to draw it to. */
const NECK_CHARMS: ReadonlySet<Charm> = new Set(['cape', 'ribbon', 'scarf']);
const SNAKE_NECK = { position: [0, -0.06, 0.03] as V3, scale: [0.62, 1, 0.62] as V3 };

/**
 * A guardian standing at `position`, turned to face `facing` (radians about y; 0 is +z). It breathes, blinks and wags
 * on its own, and hops when it is tapped. What it is made of is looked at once: mount it under a `key` that changes
 * with the guardian.
 */
export function Guardian({ guardian, position, facing = Math.PI / 4, playful = true }: {
  guardian: GuardianSpec;
  position: V3;
  facing?: number;
  /** Hops when tapped; a guardian that is not leaves the tap to whatever it stands on. */
  playful?: boolean;
}) {
  const coat = COATS[guardian.color];
  const body = useRef<Group>(null);
  const head = useRef<Group>(null);
  const eyes = useRef<Group>(null);
  const tail = useRef<Group>(null);
  /** When the hop under way began, in the clock's seconds. */
  const hop = useRef<number | null>(null);
  const tapped = useRef(false);
  const phase = position[0] * 1.7 + position[2] * 0.9;
  useAnimation((time, still) => {
    const t = time + phase;
    if (tapped.current) {
      tapped.current = false;
      hop.current = time;
    }
    const since = hop.current === null ? 1 : (time - hop.current) / 0.7;
    if (since >= 1) hop.current = null;
    const air = since < 1 ? Math.sin(since * Math.PI) : 0;
    if (body.current) {
      const breath = Math.sin(t * 2.1) * 0.012;
      body.current.position.y = air * 0.75 + Math.abs(Math.sin(t * 1.05)) * 0.03;
      body.current.scale.set(1 - breath, 1 + breath - (since < 0.12 ? 0.1 : 0), 1 - breath);
      body.current.rotation.y = since < 1 ? since * Math.PI * 2 : 0;
    }
    if (head.current) head.current.rotation.z = Math.sin(t * 0.9) * 0.07;
    // A blink every few seconds; a guardian held still for a picture keeps its eyes open.
    if (eyes.current) eyes.current.scale.y = !still && ((t % BLINK_EVERY) + BLINK_EVERY) % BLINK_EVERY < 0.13 ? 0.12 : 1;
    if (tail.current) tail.current.rotation.y = Math.sin(t * 5) * 0.28;
  });
  const snake = guardian.animal === 'snake';
  const headAt: V3 = snake ? [0, 1.42, 0.08] : HEAD;
  const eyeOut = guardian.animal === 'rooster' ? 0.2 : 0.17;
  return (
    <group
      position={position}
      rotation={[0, facing, 0]}
      userData={MOVING}
      onClick={
        playful
          ? (event) => {
              event.stopPropagation();
              tapped.current = true;
            }
          : undefined
      }
    >
      <group ref={body}>
        <Static>
          <Body animal={guardian.animal} coat={coat} />
          <group ref={tail} position={snake ? [0, 0.2, 0] : [0, 0.34, -0.42]} userData={MOVING}>
            <Static>{TAILS[guardian.animal](coat)}</Static>
          </group>
          <group ref={head} position={headAt} scale={snake ? 0.86 : 1} userData={MOVING}>
            <Static>
              <Ball radius={0.46} color={coat.main} />
              {HEADS[guardian.animal](coat)}
              {mirrored.map((side) => (
                <Ball key={side} radius={0.075} scale={[1, 0.6, 0.35]} position={[side * 0.31, -0.09, 0.335]} color={PINK} />
              ))}
              <group ref={eyes} position={[0, 0.05, 0]} userData={MOVING}>
                <Static>
                  {mirrored.map((side) => (
                    <group key={side}>
                      {/* On dark fur the eyes need something pale behind them to be seen. */}
                      {guardian.color === 'water' && <Ball radius={0.1} scale={[1, 1, 0.45]} position={[side * eyeOut, 0, 0.385]} color={coat.light} />}
                      <Ball radius={0.065} position={[side * eyeOut, 0, 0.415]} color={INK} rough={0.3} />
                      <Ball radius={0.024} position={[side * eyeOut - 0.02, 0.035, 0.465]} color="#ffffff" emissive="#ffffff" glow={0.6} />
                    </group>
                  ))}
                </Static>
              </group>
            </Static>
          </group>
          {guardian.charms.map(({ charm }) => (
            <group key={charm} {...(snake && NECK_CHARMS.has(charm) ? SNAKE_NECK : {})}>
              {CHARMS[charm]()}
            </group>
          ))}
        </Static>
      </group>
    </group>
  );
}
