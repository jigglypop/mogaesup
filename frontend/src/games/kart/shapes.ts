import { BufferAttribute, BufferGeometry } from 'three';

import type { Vec3 } from '../protocol';
import { offsetLine, type Flat } from './track';

/**
 * Plain shapes the racing island is drawn and walled with: strips along a closed line, blocks along one, and the
 * rounded outline of the land. Pure: the components turn them into meshes and colliders.
 */

/** A box turned to `yaw` about the vertical: its centre, its size (x across, y up, z along) and the turn. */
export type TurnedBox = { center: Vec3; size: Vec3; yaw: number };

/** A flat strip along `line` (closed) from `inner` to `outer` meters across it, at height `y`, facing up. */
export function strip(line: readonly Flat[], inner: number, outer: number, y: number): BufferGeometry {
  const [a, b] = [offsetLine(line, inner), offsetLine(line, outer)];
  return band(a, b, y, y);
}

/**
 * A band between two closed outlines of as many points (`near` at height `nearY`, `far` at `farY`), facing up whichever
 * way the outlines run.
 */
export function band(near: readonly Flat[], far: readonly Flat[], nearY: number, farY: number): BufferGeometry {
  const count = near.length;
  const flat: Flat[] = [];
  const positions = new Float32Array((count + 1) * 6);
  for (let index = 0; index <= count; index++) {
    const [inner, outer] = [near[index % count]!, far[index % count]!];
    positions.set([inner[0], nearY, inner[1], outer[0], farY, outer[1]], index * 6);
    flat.push(inner, outer);
  }
  const indices: number[] = [];
  for (let index = 0; index < count; index++) {
    const at = index * 2;
    upward(indices, flat, at, at + 1, at + 2);
    upward(indices, flat, at + 1, at + 3, at + 2);
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A flat fan over a convex outline (closed) at height `y`, facing up. */
export function fan(outline: readonly Flat[], y: number): BufferGeometry {
  const count = outline.length;
  const [cx, cz] = outline.reduce(([x, z], point) => [x + point[0] / count, z + point[1] / count], [0, 0]);
  const flat: Flat[] = [[cx, cz], ...outline];
  const positions = new Float32Array((count + 1) * 3);
  flat.forEach((point, index) => positions.set([point[0], y, point[1]], index * 3));
  const indices: number[] = [];
  for (let index = 0; index < count; index++) upward(indices, flat, 0, index + 1, ((index + 1) % count) + 1);
  const normals = new Float32Array((count + 1) * 3);
  for (let index = 1; index < normals.length; index += 3) normals[index] = 1;
  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Adds the triangle `a`, `b`, `c` (indices into `points` on the ground) wound to face up: seen from above, with x to the
 * right and z down the page, its corners run clockwise.
 */
function upward(indices: number[], points: readonly Flat[], a: number, b: number, c: number) {
  const [pa, pb, pc] = [points[a]!, points[b]!, points[c]!];
  const cross = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
  if (cross > 0) indices.push(a, c, b);
  else indices.push(a, b, c);
}

/** The outline of a rectangle (`min` to `max` on the ground) with corners rounded `radius` meters, `steps` points a corner. */
export function roundedOutline(min: Flat, max: Flat, radius: number, steps = 8): Flat[] {
  const corners: [Flat, number][] = [
    [[max[0] - radius, max[1] - radius], 0],
    [[min[0] + radius, max[1] - radius], Math.PI / 2],
    [[min[0] + radius, min[1] + radius], Math.PI],
    [[max[0] - radius, min[1] + radius], (Math.PI * 3) / 2],
  ];
  return corners.flatMap(([[cx, cz], from]) =>
    Array.from({ length: steps + 1 }, (_, index): Flat => {
      const angle = from + (index / steps) * (Math.PI / 2);
      return [cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius];
    }),
  );
}

/** Blocks along `line` (closed) `offset` meters across it, one every `every` points, each as long as its stretch. */
export function blocksAlong(line: readonly Flat[], offset: number, every: number, size: [number, number], y: number, extra = 0.05): TurnedBox[] {
  const side = offsetLine(line, offset).filter((_, index) => index % every === 0);
  return side.map((from, index) => {
    const to = side[(index + 1) % side.length]!;
    const [dx, dz] = [to[0] - from[0], to[1] - from[1]];
    const length = Math.hypot(dx, dz);
    return { center: [(from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2], size: [size[0], size[1], length + extra], yaw: Math.atan2(dx, dz) };
  });
}

/** The same blocks merged where they run on straight: fewer colliders. */
export function mergeStraight(blocks: readonly TurnedBox[]): TurnedBox[] {
  const merged: TurnedBox[] = [];
  let run: TurnedBox[] = [];
  const flush = () => {
    if (!run.length) return;
    const [first, last] = [run[0]!, run.at(-1)!];
    const half = (box: TurnedBox, sign: number): Flat => [box.center[0] + Math.sin(box.yaw) * box.size[2] * 0.5 * sign, box.center[2] + Math.cos(box.yaw) * box.size[2] * 0.5 * sign];
    const [from, to] = [half(first, -1), half(last, 1)];
    const [dx, dz] = [to[0] - from[0], to[1] - from[1]];
    merged.push({ center: [(from[0] + to[0]) / 2, first.center[1], (from[1] + to[1]) / 2], size: [first.size[0], first.size[1], Math.hypot(dx, dz) + 0.4], yaw: Math.atan2(dx, dz) });
    run = [];
  };
  for (const block of blocks) {
    if (run.length && Math.abs(Math.atan2(Math.sin(block.yaw - run[0]!.yaw), Math.cos(block.yaw - run[0]!.yaw))) > 0.03) flush();
    run.push(block);
  }
  flush();
  return merged;
}
