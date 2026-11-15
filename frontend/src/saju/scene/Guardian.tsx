import { useMemo, useRef, type ReactNode } from 'react';

import type { Group } from 'three';

import type { Charm, Guardian as GuardianSpec } from '../profile';
import type { DogModel } from './dogModel';
import { At, Ball, Box, BOX, Cone, Cyl, Ring, seeded, type V3 } from './kit';
import { Hover, useAnimation } from './parts';
import { MOVING, Static } from './Static';

// 수호 강아지: the dog that keeps a home (see dogs), standing on its island as its model, with what the chart's 신살
// gave it. The twenty dogs are twenty shapes, each dressed already and most with their paws full, and a head that
// hides its own neck from above: so nothing is put on a dog. A charm goes where every dog has room for it. A star or a
// canopy floats over the head, a blossom by the right ear, and a scarf, a ribbon or a cape before the left shoulder;
// a flag or a bundle stands behind the left shoulder; books, a sword or coins lie on the ground to the right. It is
// drawn facing +z, about its feet.

/** How tall a dog stands in the guardian's own measure (the stage draws guardians a little smaller than they are made). */
export const DOG_HEIGHT = 1.8;
const INK = '#2b2a36';
const GOLD = '#f2c55c';
const QUARTER = Math.PI / 2;
const gold = { metal: 0.7, rough: 0.3 } as const;

/** Where a dog has room for its charms, in the guardian's measure. */
type Fit = {
  /** The top of its head. */
  top: number;
  /** How far it reaches to either side, and behind its middle (a negative z). */
  side: number;
  back: number;
};

const fitOf = (model: DogModel): Fit => ({ top: DOG_HEIGHT, side: model.halfWidth * DOG_HEIGHT, back: model.back * DOG_HEIGHT });
/** Where a keepsake floats before the left shoulder. */
const beforeShoulder = ({ top, side }: Fit): V3 => [-side - 0.3, top * 0.46, 0.42];

const CHARMS: Record<Charm, (fit: Fit) => ReactNode> = {
  star: ({ top }) => (
    <Hover position={[0, top + 0.36, 0.05]} height={0.06} speed={2} spin={1.2}>
      <Cone radius={0.2} height={0.3} sides={4} position={[0, 0.15, 0]} color="#ffe27a" emissive="#ffc93c" glow={1.3} />
      <Cone radius={0.2} height={0.3} sides={4} position={[0, -0.15, 0]} rotation={[Math.PI, 0, 0]} color="#ffe27a" emissive="#ffc93c" glow={1.3} />
    </Hover>
  ),
  canopy: ({ top }) => (
    <Hover position={[0, top + 0.3, 0]} height={0.05} speed={1.3} spin={0.4}>
      <Cone radius={0.66} height={0.26} sides={10} position={[0, 0.13, 0]} color="#c9a0ff" />
      <Ring radius={0.64} tube={0.03} position={[0, 0, 0]} rotation={[QUARTER, 0, 0]} color={GOLD} {...gold} />
      <Ball radius={0.06} position={[0, 0.29, 0]} color={GOLD} {...gold} />
      {Array.from({ length: 5 }, (_, index) => (
        <Ball key={index} radius={0.05} position={[Math.cos(index * 1.257) * 0.62, -0.09, Math.sin(index * 1.257) * 0.62]} color="#ff9fc0" />
      ))}
    </Hover>
  ),
  blossom: ({ top, side }) => (
    <Hover position={[side * 0.74 + 0.16, top * 0.84, 0.34]} height={0.035} speed={1.7}>
      <At position={[0, 0, 0]} rotation={[-0.2, -0.5, 0.2]} scale={1.25}>
        {Array.from({ length: 5 }, (_, index) => (
          <Ball key={index} radius={0.075} scale={[1, 1, 0.5]} position={[Math.cos(index * 1.257) * 0.09, Math.sin(index * 1.257) * 0.09, 0]} color="#ffb7d0" />
        ))}
        <Ball radius={0.05} position={[0, 0, 0.03]} color="#ffe27a" />
      </At>
    </Hover>
  ),
  cape: (fit) => (
    <Hover position={beforeShoulder(fit)} height={0.04} speed={1.4} spin={0.5}>
      <Box size={[0.5, 0.46, 0.04]} position={[0, -0.06, -0.04]} rotation={[0.12, 0, 0]} color="#2f3566" twoSided />
      {([[-0.13, 0.06], [0.11, -0.02], [-0.03, -0.14], [0.15, -0.2], [-0.16, -0.22]] as const).map(([x, y]) => (
        <Ball key={`${x}${y}`} radius={0.03} position={[x, y, -0.01]} color="#ffe27a" emissive="#ffc93c" glow={1.2} />
      ))}
      <Ring radius={0.16} tube={0.035} position={[0, 0.2, 0]} rotation={[QUARTER, 0, 0]} color={GOLD} {...gold} />
    </Hover>
  ),
  ribbon: (fit) => (
    <Hover position={beforeShoulder(fit)} height={0.04} speed={1.6} spin={0.5}>
      <Cone radius={0.14} height={0.28} sides={4} position={[-0.17, 0, 0]} rotation={[0, 0, -QUARTER]} color="#e23d5a" />
      <Cone radius={0.14} height={0.28} sides={4} position={[0.17, 0, 0]} rotation={[0, 0, QUARTER]} color="#e23d5a" />
      <Ball radius={0.08} position={[0, 0, 0]} color="#c92f4b" />
    </Hover>
  ),
  scarf: (fit) => (
    <Hover position={beforeShoulder(fit)} height={0.04} speed={1.5} spin={0.5}>
      <Ring radius={0.2} tube={0.075} position={[0, 0.06, 0]} rotation={[QUARTER, 0, 0]} color="#fbfbf7" />
      {[0.5, 1.4, 2.3, 3.5, 4.4, 5.4].map((angle) => (
        <Box key={angle} size={[0.04, 0.165, 0.165]} position={[Math.cos(angle) * 0.2, 0.06, Math.sin(angle) * 0.2]} rotation={[0, -angle, 0]} color={INK} />
      ))}
      <Box size={[0.15, 0.34, 0.05]} position={[0.14, -0.14, 0.16]} rotation={[0, 0, 0.12]} color="#fbfbf7" />
      <Box size={[0.155, 0.05, 0.055]} position={[0.15, -0.22, 0.16]} rotation={[0, 0, 0.12]} color={INK} />
    </Hover>
  ),
  bundle: ({ top, side }) => (
    // Carried on a stick over the left shoulder, out past the head.
    <At position={[-side * 0.5, top * 0.34, -0.1]} rotation={[-0.35, 0, 0.82]}>
      <Cyl radius={0.03} height={1.5} sides={6} position={[0, 0.4, 0]} color="#8f5f3c" />
      <Ball radius={0.25} scale={[1, 0.9, 1]} position={[0, 1.02, 0]} color="#7fb6e8" />
      <Ball radius={0.07} position={[0.08, 1.25, 0.04]} color="#7fb6e8" />
      <Ball radius={0.07} position={[-0.08, 1.25, -0.04]} color="#7fb6e8" />
      {([[0.2, 1.05, 0.12], [-0.16, 0.92, 0.17], [0.02, 0.86, -0.22]] as const).map(([x, y, z]) => (
        <Ball key={`${x}${y}`} radius={0.045} position={[x, y, z]} color="#ffffff" />
      ))}
    </At>
  ),
  flag: ({ top, side, back }) => {
    // Planted behind the left shoulder, its cloth flying clear of the head.
    const pole: V3 = [-side - 0.12, 0, back * 0.5];
    const height = top + 0.28;
    return (
      <>
        <Cyl radius={0.025} height={height} sides={6} position={[pole[0], height / 2, pole[2]]} color="#8f5f3c" />
        <Ball radius={0.05} position={[pole[0], height + 0.03, pole[2]]} color={GOLD} {...gold} />
        <Box size={[0.55, 0.36, 0.02]} position={[pole[0] - 0.29, height - 0.2, pole[2]]} color="#e23d3d" twoSided />
        <Box size={[0.55, 0.05, 0.025]} position={[pole[0] - 0.29, height - 0.04, pole[2]]} color={GOLD} />
      </>
    );
  },
  books: ({ side }) => (
    <At position={[side + 0.42, 0, 0.18]}>
      <Box size={[0.5, 0.12, 0.38]} position={[0, 0.06, 0]} color="#e2674f" />
      <Box size={[0.46, 0.1, 0.34]} position={[0.01, 0.17, 0]} rotation={[0, 0.3, 0]} color="#5a9be0" />
      <Box size={[0.4, 0.09, 0.3]} position={[0, 0.265, 0]} rotation={[0, -0.2, 0]} color="#6fbf6a" />
      <Cyl radius={0.1} height={0.22} sides={10} position={[-0.08, 0.11, -0.4]} color="#f3e6cf" />
      <Cyl radius={0.015} height={0.36} sides={5} position={[-0.11, 0.3, -0.4]} rotation={[0, 0, 0.2]} color="#8f5f3c" />
      <Cyl radius={0.015} height={0.36} sides={5} position={[-0.04, 0.3, -0.38]} rotation={[0.2, 0, -0.2]} color={INK} />
    </At>
  ),
  sword: ({ side }) => (
    <At position={[side + 0.3, 0, 0.12]} rotation={[0, 0, -0.14]}>
      <Box size={[0.09, 0.85, 0.028]} position={[0, 0.5, 0]} color="#dfe6f1" metal={0.8} rough={0.25} />
      <Box size={[0.34, 0.06, 0.09]} position={[0, 0.95, 0]} color={GOLD} {...gold} />
      <Box size={[0.07, 0.22, 0.07]} position={[0, 1.08, 0]} color="#5b4636" />
      <Ball radius={0.055} position={[0, 1.21, 0]} color={GOLD} {...gold} />
    </At>
  ),
  coins: ({ side }) => (
    <At position={[side + 0.32, 0, 0.2]}>
      {[0, 1, 2, 3, 4].map((index) => (
        <Cyl key={index} radius={0.16} height={0.05} sides={14} position={[seeded(index) * 0.04, 0.025 + index * 0.052, seeded(index + 3) * 0.04]} color={GOLD} {...gold} />
      ))}
      <Cyl radius={0.16} height={0.05} sides={14} position={[0.3, 0.16, 0.08]} rotation={[0, 0.4, 1.25]} color={GOLD} {...gold} />
    </At>
  ),
};

/**
 * A guardian dog standing at `position`, turned to face `facing` (radians about y; 0 is +z). It breathes and sways on
 * its own, and hops when it is tapped. What it is made of is looked at once: mount it under a `key` that changes with
 * the guardian.
 */
export function Guardian({ guardian, model, position, facing = Math.PI / 4, playful = true }: {
  guardian: GuardianSpec;
  /** The dog's model, loaded (see dogModel). */
  model: DogModel;
  position: V3;
  facing?: number;
  /** Hops when tapped; a guardian that is not leaves the tap to whatever it stands on. */
  playful?: boolean;
}) {
  // The mesh and its picture are the model's own; only the handful of nodes that hold them are this dog's.
  const figure = useMemo(() => {
    const copy = model.scene.clone();
    // Taps are caught by a plain box about the dog, not by its thousands of triangles.
    copy.traverse((object) => {
      object.raycast = () => undefined;
    });
    return copy;
  }, [model]);
  const fit = useMemo(() => fitOf(model), [model]);
  const body = useRef<Group>(null);
  /** When the hop under way began, in the clock's seconds. */
  const hop = useRef<number | null>(null);
  const tapped = useRef(false);
  const phase = position[0] * 1.7 + position[2] * 0.9;
  useAnimation((time) => {
    const t = time + phase;
    if (tapped.current) {
      tapped.current = false;
      hop.current = time;
    }
    const since = hop.current === null ? 1 : (time - hop.current) / 0.7;
    if (since >= 1) hop.current = null;
    const air = since < 1 ? Math.sin(since * Math.PI) : 0;
    const group = body.current;
    if (!group) return;
    const breath = Math.sin(t * 2.1) * 0.012;
    group.position.y = air * 0.75 + Math.abs(Math.sin(t * 1.05)) * 0.03;
    group.scale.set(1 - breath, 1 + breath - (since < 0.12 ? 0.1 : 0), 1 - breath);
    group.rotation.y = since < 1 ? since * Math.PI * 2 : 0;
    // It rocks a little from foot to foot.
    group.rotation.z = Math.sin(t * 0.9) * 0.035;
  });
  return (
    <group position={position} rotation={[0, facing, 0]} userData={MOVING}>
      <group ref={body}>
        <group scale={DOG_HEIGHT} userData={MOVING}>
          <primitive object={figure} />
        </group>
        <Static>
          {guardian.charms.map(({ charm }) => (
            <group key={charm}>{CHARMS[charm](fit)}</group>
          ))}
        </Static>
      </group>
      {playful && (
        <mesh
          geometry={BOX}
          position={[0, DOG_HEIGHT / 2, 0]}
          scale={[fit.side * 2, DOG_HEIGHT, Math.max(0.8, -fit.back * 2)]}
          visible={false}
          onClick={(event) => {
            event.stopPropagation();
            tapped.current = true;
          }}
        />
      )}
    </group>
  );
}
