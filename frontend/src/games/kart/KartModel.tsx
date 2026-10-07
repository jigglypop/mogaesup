import { memo, useEffect, useMemo, useRef, type RefObject } from 'react';

import {
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Mesh,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** A kart's booster flame and water bubble, shown while the server's times (or the page's own boost) say so. */
export type KartRefs = { flame: RefObject<Mesh | null>; bubble: RefObject<Mesh | null> };
/** Its colours besides the racer's own paint (tokens.css). */
export type KartPalette = { tire: string; seat: string; bubble: string; flame: string; metal: string; suit: string; skin: string; face: string };
type Point = [number, number, number];

/** Markers are left out of picking, so a click on one walks to the ground under it. */
const noRaycast = () => null;
/** Left out of the camera's collision: the chase camera rides over the karts. */
const PASS = { intangible: true };
const UP = new Vector3(0, 1, 0);

function at(geometry: BufferGeometry, position: Point, rotation: Point = [0, 0, 0]): BufferGeometry {
  geometry.rotateX(rotation[0]);
  geometry.rotateY(rotation[1]);
  geometry.rotateZ(rotation[2]);
  return geometry.translate(...position);
}

function box(size: Point, position: Point, radius = 0.06, rotation?: Point): BufferGeometry {
  return at(new RoundedBoxGeometry(...size, 1, radius), position, rotation);
}

function ball(size: Point, position: Point): BufferGeometry {
  return at(new SphereGeometry(1, 12, 8).scale(...size), position);
}

function rod(from: Point, to: Point, radius: number): BufferGeometry {
  const start = new Vector3(...from);
  const end = new Vector3(...to);
  const direction = end.clone().sub(start);
  const geometry = new CylinderGeometry(radius, radius, direction.length(), 8, 1);
  geometry.applyQuaternion(new Quaternion().setFromUnitVectors(UP, direction.normalize()));
  return geometry.translate(...start.add(end).multiplyScalar(0.5).toArray());
}

/** One static mesh per material. All racers share these buffers; the wheels are not a draw call each. */
function combine(parts: BufferGeometry[]): BufferGeometry {
  const nonIndexed = parts.map((geometry) => geometry.index ? geometry.toNonIndexed() : geometry);
  const merged = mergeGeometries(nonIndexed, false);
  for (let index = 0; index < parts.length; index++) {
    nonIndexed[index]!.dispose();
    if (nonIndexed[index] !== parts[index]) parts[index]!.dispose();
  }
  if (!merged) throw new Error('Kart geometry could not be merged');
  merged.computeBoundingSphere();
  return merged;
}

const WHEELS: Point[] = [-0.91, 0.91].flatMap((x) => [-0.93, 0.93].map((z): Point => [x, 0.36, z]));

const paint = [
  box([1.48, 0.27, 2.42], [0, 0.42, 0], 0.12),
  box([1.2, 0.31, 0.95], [0, 0.63, 0.81], 0.12, [0.08, 0, 0]),
  box([1.56, 0.22, 0.25], [0, 0.42, 1.44], 0.1),
  box([1.62, 0.2, 0.25], [0, 0.43, -1.34], 0.09),
  box([1.65, 0.09, 0.38], [0, 1.02, -1.29], 0.035),
  ball([0.37, 0.38, 0.34], [0, 1.62, -0.34]),
];
const rubber = [
  box([1.53, 0.1, 0.1], [0, 0.37, 1.58], 0.035),
  box([1.59, 0.1, 0.09], [0, 0.38, -1.47], 0.035),
];
const metal = [
  rod([0, 0.66, 0.45], [0, 1.04, 0.22], 0.035),
  at(new CylinderGeometry(0.1, 0.1, 0.22, 10), [0, 0.49, -1.49], [Math.PI / 2, 0, 0]),
];
const seat = [
  box([0.79, 0.13, 0.74], [0, 0.64, -0.39], 0.065),
  box([0.77, 0.53, 0.15], [0, 0.88, -0.78], 0.065, [-0.13, 0, 0]),
  at(new TorusGeometry(0.22, 0.035, 6, 16), [0, 1.08, 0.24], [-0.55, 0, 0]),
  rod([-0.17, 1.08, 0.24], [0.17, 1.08, 0.24], 0.02),
];
const ivory = [
  box([0.14, 0.015, 0.78], [0, 0.8, 0.82], 0.005, [0.08, 0, 0]),
  ball([0.25, 0.3, 0.2], [0, 1.04, -0.38]),
  ...[Math.PI / 2, Math.PI * 1.5].map((angle) => at(
    new SphereGeometry(1, 2, 8, angle - 0.085, 0.17, 0, Math.PI * 0.68).scale(0.376, 0.386, 0.346),
    [0, 1.62, -0.34],
  )),
];
const skin = [ball([0.265, 0.245, 0.22], [0, 1.54, -0.1])];
const face = [
  ball([0.032, 0.043, 0.025], [-0.092, 1.57, 0.11]),
  ball([0.032, 0.043, 0.025], [0.092, 1.57, 0.11]),
  at(new TorusGeometry(0.075, 0.012, 4, 8, Math.PI), [0, 1.49, 0.113], [0, 0, Math.PI]),
];

for (const [x, y, z] of WHEELS) {
  rubber.push(at(new CylinderGeometry(0.36, 0.36, 0.29, 14, 1), [x, y, z], [0, 0, Math.PI / 2]));
  // The painted half arch leaves the lower tire and pale hub visible from the chase camera.
  paint.push(at(new TorusGeometry(0.415, 0.065, 6, 12, Math.PI), [x, y, z], [0, Math.PI / 2, 0]));
  metal.push(at(new CylinderGeometry(0.195, 0.195, 0.31, 10, 1), [x, y, z], [0, 0, Math.PI / 2]));
  ivory.push(at(new CylinderGeometry(0.085, 0.085, 0.33, 8, 1), [x, y, z], [0, 0, Math.PI / 2]));
}

for (const side of [-1, 1]) {
  paint.push(box([0.27, 0.3, 1.2], [0.72 * side, 0.61, -0.05], 0.07));
  seat.push(box([0.08, 0.37, 0.11], [0.51 * side, 0.79, -1.29], 0.025));
  ivory.push(
    rod([0.19 * side, 1.16, -0.37], [0.23 * side, 1.05, 0.2], 0.078),
    rod([0.12 * side, 0.85, -0.29], [0.18 * side, 0.72, 0.42], 0.095),
    at(new CylinderGeometry(0.09, 0.09, 0.045, 10), [0.38 * side, 0.62, 1.293], [Math.PI / 2, 0, 0]),
  );
  skin.push(ball([0.09, 0.085, 0.09], [0.22 * side, 1.09, 0.25]));
  rubber.push(box([0.18, 0.1, 0.29], [0.18 * side, 0.72, 0.48], 0.045));
}

const GEOMETRY = {
  paint: combine(paint),
  rubber: combine(rubber),
  metal: combine(metal),
  seat: combine(seat),
  ivory: combine(ivory),
  skin: combine(skin),
  face: combine(face),
  flame: new ConeGeometry(0.27, 1.0, 10, 1),
  bubble: new SphereGeometry(1.8, 20, 12),
};

/**
 * A compact SD kart facing +z in the racer's colour: a rounded body with side pods, bumpers and a rear wing, four wheels
 * under painted arches, and a driver in a helmet of the same colour at the wheel.
 */
export const KartModel = memo(function KartModel({ color, colors, refs }: { color: string; colors: KartPalette; refs: KartRefs }) {
  const materials = useMemo(() => ({
    paint: new MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.12 }),
    rubber: new MeshStandardMaterial({ color: colors.tire, roughness: 0.95 }),
    metal: new MeshStandardMaterial({ color: colors.metal, roughness: 0.38, metalness: 0.65 }),
    seat: new MeshStandardMaterial({ color: colors.seat, roughness: 0.85 }),
    ivory: new MeshStandardMaterial({ color: colors.suit, roughness: 0.7 }),
    skin: new MeshStandardMaterial({ color: colors.skin, roughness: 0.8 }),
    face: new MeshStandardMaterial({ color: colors.face, roughness: 0.85 }),
    flame: new MeshStandardMaterial({ color: colors.flame, emissive: colors.flame, emissiveIntensity: 1.4, transparent: true, opacity: 0.85 }),
    bubble: new MeshStandardMaterial({ color: colors.bubble, transparent: true, opacity: 0.3, roughness: 0.1, depthWrite: false }),
  }), [color, colors.tire, colors.seat, colors.flame, colors.bubble, colors.metal, colors.suit, colors.skin, colors.face]);
  useEffect(() => () => {
    for (const material of Object.values(materials)) material.dispose();
  }, [materials]);

  return (
    <group userData={PASS} dispose={null}>
      {(['paint', 'rubber', 'metal', 'seat', 'ivory', 'skin', 'face'] as const).map((part) => (
        <mesh key={part} geometry={GEOMETRY[part]} material={materials[part]} raycast={noRaycast} castShadow />
      ))}
      <mesh ref={refs.flame} geometry={GEOMETRY.flame} material={materials.flame} position={[0, 0.49, -1.99]} rotation={[-Math.PI / 2, 0, 0]} visible={false} raycast={noRaycast} />
      <mesh ref={refs.bubble} geometry={GEOMETRY.bubble} material={materials.bubble} position={[0, 1.1, 0]} visible={false} raycast={noRaycast} />
    </group>
  );
});

export function useKartRefs(): KartRefs {
  const flame = useRef<Mesh>(null);
  const bubble = useRef<Mesh>(null);
  return useMemo(() => ({ flame, bubble }), []);
}
