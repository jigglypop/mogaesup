import { describe, expect, it } from 'vitest';

import { at, createVillage, SPAWN } from '../../minihome/village';
import type { GameSession, Vec3 } from '../protocol';
import { gameOf } from '../registry';
import { findField, fromField, rollBall, toField, type Field, type FieldView } from '../soccer/field';
import { openSpots } from '../spots';

/** Open cells (4 m apart) over columns `x0..x1` and rows `z0..z1` of the grid, at `y`. */
const block = (x0: number, x1: number, z0: number, z1: number, y = 0): Vec3[] => {
  const spots: Vec3[] = [];
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) spots.push([x * 4, y, z * 4]);
  return spots;
};

/** What the server takes (server/src/games/soccer.rs). */
function playable({ center, axis, halfLength, halfWidth }: Field) {
  const [reachX, reachZ] = axis === 'x' ? [halfLength, halfWidth] : [halfWidth, halfLength];
  return (
    halfLength >= 10 && halfLength <= 24 && halfWidth >= 6 && halfWidth <= halfLength && halfWidth <= 14 &&
    Math.abs(center[0]) + reachX <= 200 && Math.abs(center[2]) + reachZ <= 200 && Math.abs(center[1]) <= 200
  );
}

describe('축구 경기장 고르기', () => {
  it('모개숲에서는 바닷가 쪽의 가장 큰 빈 땅에 놓고, 서버가 받는 배치를 보낸다', () => {
    const building = createVillage();
    const spots = openSpots(building, { bounds: () => undefined });
    const beach: Field = { center: [8, 0, 18], axis: 'x', halfLength: 18, halfWidth: 8 };
    expect(findField(spots, [SPAWN[0], 0, SPAWN[2]])).toEqual(beach);
    // Every cell under it is open; the campfire's, on the beach beside it, stays out.
    for (let u = -16; u <= 16; u += 4) for (let v = -6; v <= 6; v += 4) expect(spots).toContainEqual(fromField(beach, u, v));
    expect(spots).not.toContainEqual([at(4), 0, at(12)]);
    expect(Math.abs(toField(beach, [at(4), 0, at(12)])[0])).toBeGreaterThan(beach.halfLength);
    // From the far corner of the woods nothing fits nearby, so the biggest field that fits anywhere it is.
    expect(findField(spots, [at(1), 0, at(2)])).toEqual(beach);
    const session = { kind: 'soccer' } as GameSession;
    expect(gameOf('soccer')!.layout({ building, spots: () => spots, position: [SPAWN[0], 1, SPAWN[2]], session })).toEqual(beach);
  });

  it('넓은 땅에서는 서버가 받는 가장 큰 경기장을 사람 가까이에 놓는다', () => {
    const open = block(-20, 20, -20, 20);
    const field = findField(open, [10, 0, -6]);
    expect(field).toMatchObject({ axis: 'x', halfLength: 24, halfWidth: 14 });
    // On the cells around the host: they stand inside it.
    const [u, v] = toField(field, [10, 0, -6]);
    expect(Math.abs(u)).toBeLessThanOrEqual(24);
    expect(Math.abs(v)).toBeLessThanOrEqual(14);
    expect(playable(field)).toBe(true);
  });

  it('긴 쪽이 z로 뻗은 땅이면 경기장도 z를 따라 놓는다', () => {
    const strip = block(0, 3, 0, 9, 1.5);
    expect(findField(strip, [4, 1.5, 4])).toEqual({ center: [6, 1.5, 18], axis: 'z', halfLength: 20, halfWidth: 8 });
  });

  it('가까운 빈 땅을 먼 큰 땅보다 먼저 고르고, 가까운 곳이 없으면 가장 큰 곳을 고른다', () => {
    const small = block(0, 5, 0, 2);
    const big = block(30, 41, 30, 36);
    const spots = [...small, ...big];
    expect(findField(spots, [8, 0, 4])).toEqual({ center: [10, 0, 4], axis: 'x', halfLength: 12, halfWidth: 6 });
    expect(findField(spots, [140, 0, 130])).toMatchObject({ halfLength: 24, halfWidth: 14 });
    // Far from both, the bigger one.
    expect(findField(spots, [-150, 0, -150])).toMatchObject({ halfLength: 24, halfWidth: 14 });
  });

  it('빈 땅이 모자라면 가장 많이 덮는 곳에 가장 작은 경기장을, 빈 자리가 없으면 방장 자리에 놓는다', () => {
    // Two rows only, too narrow anywhere: the smallest field over the most open cells, nearest the host.
    const narrow = block(0, 9, 0, 1);
    const field = findField(narrow, [0, 0, 0]);
    expect(field).toMatchObject({ halfLength: 10, halfWidth: 6 });
    expect(playable(field)).toBe(true);
    const covered = narrow.filter((spot) => {
      const [u, v] = toField(field, spot);
      return Math.abs(u) < field.halfLength && Math.abs(v) < field.halfWidth;
    });
    expect(covered).toHaveLength(10);
    expect(findField([], [12.3456, 0, -7])).toEqual({ center: [12.35, 0, -7], axis: 'x', halfLength: 10, halfWidth: 6 });
    expect(playable(findField([], null))).toBe(true);
  });

  it('섬의 가장자리에서도 서버의 범위 안에 놓는다', () => {
    const edge = block(44, 49, 44, 49);
    const field = findField(edge, [196, 0, 196]);
    expect(playable(field)).toBe(true);
    expect(findField([], [199, 0, -199])).toEqual({ center: [190, 0, -194], axis: 'x', halfLength: 10, halfWidth: 6 });
  });
});

describe('축구공 그리기', () => {
  const field: FieldView = { center: [10, 0, -5], axis: 'x', halfLength: 20, halfWidth: 12, mouth: 6 };
  const along: FieldView = { ...field, axis: 'z' };
  const ball = (position: Vec3, velocity: Vec3) => ({ position, velocity, at: 1_000 });

  it('서버처럼 1초마다 속도의 40%만 남기며 굴러가다 멈춘다', () => {
    const rolled = (10 * (1 - 0.4)) / Math.log(1 / 0.4);
    expect(rollBall(ball([10, 0, -5], [10, 0, 0]), field, 2_000)[0]).toBeCloseTo(10 + rolled, 6);
    // Before its time, and at rest, it stays where the view put it.
    expect(rollBall(ball([10, 0, -5], [10, 0, 0]), field, 900)).toEqual([10, 0, -5]);
    expect(rollBall(ball([12, 0, -3], [0, 0, 0]), field, 60_000)).toEqual([12, 0, -3]);
    // It stops below 0.1 m/s, short of where the decay alone would take it, and never moves again.
    const late = rollBall(ball([10, 0, -5], [10, 0, 0]), field, 10_000);
    expect(late[0]).toBeLessThan(10 + 10 / Math.log(1 / 0.4));
    expect(rollBall(ball([10, 0, -5], [10, 0, 0]), field, 60_000)).toEqual(late);
  });

  it('옆줄과 골문 밖의 끝줄에서는 튕기고, 골문 안으로는 그물까지 들어간다', () => {
    const side = rollBall(ball([10, 0, 5], [0, 0, 12]), field, 1_500);
    expect(side[2]).toBeLessThanOrEqual(7);
    expect(side[2]).toBeGreaterThan(5);
    const post = rollBall(ball([28, 0, -1], [10, 0, 0]), field, 1_500);
    expect(post[0]).toBeLessThan(30);
    const goal = rollBall(ball([28, 0, -5], [10, 0, 0]), field, 3_000);
    expect(goal[0]).toBeCloseTo(31.2, 6);
    // A field along z rolls the same way along z.
    expect(rollBall(ball([10, 0, -5], [0, 0, 10]), along, 2_000)[2]).toBeCloseTo(-5 + (10 * (1 - 0.4)) / Math.log(1 / 0.4), 6);
  });
});
