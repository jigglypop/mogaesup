import type { ReactNode } from 'react';

import { BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, DoubleSide, MeshStandardMaterial, SphereGeometry, TorusGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// The building blocks of what is mounted shape by shape because it moves: the guardian, a bridge's rails. A few shared
// shapes scaled into place, and one material a colour, glazed like a figure of fired clay. The homes themselves are
// piled up by a Builder (see build).

export type V3 = [number, number, number];

type Look = {
  /** 0 mirror … 1 chalk. */
  rough?: number;
  metal?: number;
  /** Glows in this colour, `glow` strong. */
  emissive?: string;
  glow?: number;
  /** Below 1 it is see-through. */
  opacity?: number;
  /** Seen from behind too (a flag, a leaf). */
  twoSided?: boolean;
};

const materials = new Map<string, MeshStandardMaterial>();
const plain = new WeakMap<MeshStandardMaterial, { rough: number; metal: number; twoSided: boolean }>();

/**
 * The finish of a material that is nothing but a colour and a finish (it neither glows nor lets light through), or
 * undefined: shapes painted so can be drawn together, whatever their colours (see Static).
 */
export const plainLook = (material: MeshStandardMaterial) => plain.get(material);

/** The material of a colour and look, made once. */
export function mat(color: string, look: Look = {}): MeshStandardMaterial {
  const { rough = 0.46, metal = 0, emissive, glow = 1, opacity = 1, twoSided = false } = look;
  const key = `${color}|${rough}|${metal}|${emissive ?? ''}|${glow}|${opacity}|${twoSided}`;
  let material = materials.get(key);
  if (!material) {
    material = new MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    if (emissive) {
      material.emissive.set(emissive);
      material.emissiveIntensity = glow;
    }
    if (opacity < 1) {
      material.transparent = true;
      material.opacity = opacity;
      material.depthWrite = false;
    }
    if (twoSided) material.side = DoubleSide;
    if (!emissive && opacity >= 1) plain.set(material, { rough, metal, twoSided });
    materials.set(key, material);
  }
  return material;
}

/** A box one metre each way, for anything that only needs scaling. */
export const BOX = new BoxGeometry(1, 1, 1);
/** A ball of radius one. */
export const SPHERE = new SphereGeometry(1, 28, 18);
const geometries = new Map<string, BufferGeometry>();

function cached<T extends BufferGeometry>(key: string, make: () => T): T {
  let geometry = geometries.get(key);
  if (!geometry) {
    geometry = make();
    geometries.set(key, geometry);
  }
  return geometry as T;
}

type Placed = { position?: V3; rotation?: V3; children?: ReactNode };
type Painted = Placed & { color: string } & Look;

const lookOf = ({ rough, metal, emissive, glow, opacity, twoSided }: Look): Look => ({
  ...(rough === undefined ? {} : { rough }),
  ...(metal === undefined ? {} : { metal }),
  ...(emissive === undefined ? {} : { emissive }),
  ...(glow === undefined ? {} : { glow }),
  ...(opacity === undefined ? {} : { opacity }),
  ...(twoSided === undefined ? {} : { twoSided }),
});

/** Whether a mesh throws a shadow: see-through and glowing things do not. */
const casts = (look: Look) => (look.opacity ?? 1) >= 1 && !look.emissive;

/** A box `size` wide, high and deep; `round` softens its edges by that much. */
export function Box({ size, round, position, rotation, color, children, ...look }: Painted & { size: V3; round?: number }) {
  const material = mat(color, lookOf(look));
  if (round) {
    const geometry = cached(`rbox|${size.join(',')}|${round}`, () => new RoundedBoxGeometry(size[0], size[1], size[2], 3, round));
    return (
      <mesh geometry={geometry} material={material} position={position} rotation={rotation} castShadow={casts(look)} receiveShadow>
        {children}
      </mesh>
    );
  }
  return (
    <mesh geometry={BOX} material={material} position={position} rotation={rotation} scale={size} castShadow={casts(look)} receiveShadow>
      {children}
    </mesh>
  );
}

/** An upright cylinder; `top` gives it a different radius at the top (a cone's stump, a jar's shoulder). */
export function Cyl({ radius, top = radius, height, sides = 18, position, rotation, color, children, ...look }: Painted & { radius: number; top?: number; height: number; sides?: number }) {
  const geometry = cached(`cyl|${(top / radius).toFixed(3)}|${sides}`, () => new CylinderGeometry(top / radius, 1, 1, sides));
  return (
    <mesh geometry={geometry} material={mat(color, lookOf(look))} position={position} rotation={rotation} scale={[radius, height, radius]} castShadow={casts(look)} receiveShadow>
      {children}
    </mesh>
  );
}

export function Cone({ radius, height, sides = 16, position, rotation, color, children, ...look }: Painted & { radius: number; height: number; sides?: number }) {
  const geometry = cached(`cone|${sides}`, () => new ConeGeometry(1, 1, sides));
  return (
    <mesh geometry={geometry} material={mat(color, lookOf(look))} position={position} rotation={rotation} scale={[radius, height, radius]} castShadow={casts(look)} receiveShadow>
      {children}
    </mesh>
  );
}

/** A ball, or with `scale` an egg, a pebble, a cushion. */
export function Ball({ radius, scale = [1, 1, 1], position, rotation, color, children, ...look }: Painted & { radius: number; scale?: V3 }) {
  return (
    <mesh geometry={SPHERE} material={mat(color, lookOf(look))} position={position} rotation={rotation} scale={[radius * scale[0], radius * scale[1], radius * scale[2]]} castShadow={casts(look)} receiveShadow>
      {children}
    </mesh>
  );
}

/**
 * A ring standing upright, facing +z (a quarter turn about x lays it flat): `radius` to the middle of its tube, `tube`
 * thick. `arc` leaves it open (a horn, a handle, a tail).
 */
export function Ring({ radius, tube, arc = Math.PI * 2, position, rotation, color, children, ...look }: Painted & { radius: number; tube: number; arc?: number }) {
  const geometry = cached(`ring|${(tube / radius).toFixed(3)}|${arc.toFixed(3)}`, () => new TorusGeometry(1, tube / radius, 10, 28, arc));
  return (
    <mesh geometry={geometry} material={mat(color, lookOf(look))} position={position} rotation={rotation} scale={radius} castShadow={casts(look)} receiveShadow>
      {children}
    </mesh>
  );
}

/** A group moved and turned into place. */
export function At({ position, rotation, scale, children }: Placed & { scale?: number | V3 }) {
  return (
    <group position={position} rotation={rotation} scale={scale}>
      {children}
    </group>
  );
}

/** A number between 0 and 1 that stays the same for the same `seed`: scatter that does not move between draws. */
export function seeded(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}
