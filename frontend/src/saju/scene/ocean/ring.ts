import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, Vector3, type Camera } from 'three';

import { WATER_LEVEL } from '../mood';

// The lake's surface is one mesh of rings about the middle of the picture, laid on the water wherever the camera looks.
// The camera draws without perspective, so every part of the picture needs the same grain of corners: the rings are
// as far apart as their corners are, out to a disc that just holds the canvas's corners, and past it a skirt of a few
// wide rings runs on, flat, far beyond any edge the picture could show.

/** The skirt's rings, as multiples of the disc's radius: the waves have died away by the first. */
export const SKIRT = [1.2, 2.5, 10, 60] as const;
/** The disc holds the canvas's corners with this much to spare, for the waves' lean and lift. */
export const COVER_MARGIN = 1.12;

/** The corners of a ring `index` rings out from the middle: as many as keep them as far apart as the rings are. */
export const ringCorners = (index: number) => Math.max(8, Math.ceil((2 * Math.PI * index) / 8) * 8);

type Ring = { start: number; count: number; offset: number };

/**
 * A disc of `rings` evenly spaced rings about the origin, radius 1 in the xz-plane and facing up, then the skirt. Each
 * corner's position is where it lies on that unit disc; the surface's shader lays the disc on the water (see placeRing).
 */
export function ringGeometry(rings: number): BufferGeometry {
  const positions: number[] = [0, 0, 0];
  const all: Ring[] = [];
  const add = (radius: number, count: number, offset: number) => {
    all.push({ start: positions.length / 3, count, offset });
    for (let corner = 0; corner < count; corner++) {
      const angle = ((corner + offset) / count) * Math.PI * 2;
      positions.push(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    }
  };
  for (let index = 1; index <= rings; index++) add(index / rings, ringCorners(index), (index % 2) * 0.5);
  for (const radius of SKIRT) add(radius, ringCorners(rings), 0);

  const indices: number[] = [];
  // Wound so that each face looks up: counter-clockwise seen from above.
  const face = (a: number, b: number, c: number) => {
    const ax = positions[a * 3]!;
    const az = positions[a * 3 + 2]!;
    const cross = (positions[b * 3 + 2]! - az) * (positions[c * 3]! - ax) - (positions[b * 3]! - ax) * (positions[c * 3 + 2]! - az);
    if (cross >= 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  };
  const first = all[0]!;
  for (let corner = 0; corner < first.count; corner++) face(0, first.start + corner, first.start + ((corner + 1) % first.count));
  // Two rings of different counts are joined by walking round both at once, always on along the one whose next corner
  // comes first, until both are back where they began.
  const at = (ring: Ring, step: number) => ring.start + (step % ring.count);
  const turn = (ring: Ring, step: number) => (step + ring.offset) / ring.count;
  for (let ring = 1; ring < all.length; ring++) {
    const inner = all[ring - 1]!;
    const outer = all[ring]!;
    let i = 0;
    let j = 0;
    while (i < inner.count || j < outer.count) {
      const onInner = j >= outer.count || (i < inner.count && turn(inner, i + 1) <= turn(outer, j + 1));
      if (onInner) {
        face(at(inner, i), at(outer, j), at(inner, i + 1));
        i += 1;
      } else {
        face(at(inner, i), at(outer, j), at(outer, j + 1));
        j += 1;
      }
    }
  }
  const normals = new Float32Array(positions.length);
  for (let index = 1; index < normals.length; index += 3) normals[index] = 1;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(new Uint32BufferAttribute(new Uint32Array(indices), 1));
  return geometry;
}

/** Where the disc lies on the water: its middle, and where the ends of its x and z radii fall from there. */
export type RingPlace = { centre: Vector3; across: Vector3; along: Vector3 };

const point = new Vector3();
const ahead = new Vector3();

/** Where the ray through the picture's point (x, y), in normalized device coordinates, meets the water. */
function onWater(camera: Camera, x: number, y: number, out: Vector3): boolean {
  camera.getWorldDirection(ahead);
  if (ahead.y > -1e-4) return false;
  point.set(x, y, 0).unproject(camera);
  const reach = (WATER_LEVEL - point.y) / ahead.y;
  out.copy(ahead).multiplyScalar(reach).add(point);
  return true;
}

const right = new Vector3();
const up = new Vector3();

/**
 * Lays the disc on the water for an orthographic `camera` drawing a canvas `width` by `height` pixels, writing into
 * `place`: about the point under the canvas's middle, its radii as long in pixels both ways, and long enough that the
 * disc holds every corner of the canvas with {@link COVER_MARGIN} to spare. False when the camera does not look down.
 */
export function placeRing(camera: Camera, width: number, height: number, place: RingPlace): boolean {
  if (!onWater(camera, 0, 0, place.centre) || !onWater(camera, 1, 0, right) || !onWater(camera, 0, 1, up)) return false;
  // Half the canvas across and half of it up, as they lie on the water.
  right.sub(place.centre);
  up.sub(place.centre);
  const aspect = height / Math.max(1, width);
  // In pixels the disc's radius is half the canvas's diagonal: that many times its half-width across, and its half-height up.
  place.across.copy(right).multiplyScalar(COVER_MARGIN * Math.hypot(1, aspect));
  place.along.copy(up).multiplyScalar(COVER_MARGIN * Math.hypot(1, 1 / aspect));
  // The disc is wound to face up: laid with its z radius toward the camera, not away, it would show its back.
  if (place.across.x * place.along.z - place.across.z * place.along.x < 0) place.along.negate();
  return true;
}

/** Where the disc's point (x, z) lies on the water once placed. */
export function ringPoint(place: RingPlace, x: number, z: number, out: Vector3): Vector3 {
  return out.copy(place.centre).addScaledVector(place.across, x).addScaledVector(place.along, z);
}

/** Where on the disc a point of the water lies: {@link ringPoint} the other way. */
export function onRing(place: RingPlace, x: number, z: number): { x: number; z: number } {
  const dx = x - place.centre.x;
  const dz = z - place.centre.z;
  const { across: a, along: b } = place;
  const determinant = a.x * b.z - a.z * b.x;
  return { x: (dx * b.z - dz * b.x) / determinant, z: (a.x * dz - a.z * dx) / determinant };
}
