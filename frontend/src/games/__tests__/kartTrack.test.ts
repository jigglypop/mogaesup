import { describe, expect, it } from 'vitest';

import { ARENA_Y } from '../arenaMap';
import { kartLayout } from '../kart/layout';
import { BOOSTS, BOXES, frame, GATES, GRID, HALF_WIDTH, lapLength, MIDDLE, nearest, START, type Flat } from '../kart/track';
import type { GameSession } from '../protocol';

const apart = (a: Flat, b: Flat) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** How far `point` is from the segment `from`–`to`. */
function offSegment(point: Flat, from: Flat, to: Flat): number {
  const [dx, dz] = [to[0] - from[0], to[1] - from[1]];
  const share = Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dz) / (dx * dx + dz * dz)));
  return apart(point, [from[0] + dx * share, from[1] + dz * share]);
}

const session = (people: number) =>
  ({ kind: 'kart', phase: 'lobby', host: 'p0', players: Array.from({ length: people }, (_, index) => ({ id: `p${index}`, name: `p${index}`, peer: null })), you: 'p0', game: null, result: null, seq: 1, now: 0 }) as GameSession;

describe('카트 서킷', () => {
  it('게이트는 출발선에서 시작해 한 바퀴를 순서대로 돌고 닫힌다', () => {
    expect(GATES.length).toBeGreaterThanOrEqual(8);
    expect(GATES.length).toBeLessThanOrEqual(64);
    expect(GATES[0]).toEqual(START);
    // Each gate is a short drive from the one before, the last from the first too, and they go round the middle line in order.
    const order = GATES.map((gate) => nearest(gate));
    for (let index = 0; index < GATES.length; index++) {
      const step = apart(GATES[index]!, GATES[(index + 1) % GATES.length]!);
      expect(step).toBeGreaterThan(1);
      expect(step).toBeLessThanOrEqual(40.5);
      if (index > 0) expect(order[index]!).toBeGreaterThan(order[index - 1]!);
    }
    // KartRider's size: most of a kilometer round.
    expect(lapLength()).toBeGreaterThan(600);
    expect(lapLength()).toBeLessThan(950);
  });

  it('봇이 게이트 사이를 곧게 가도 길 위에 있고, 서로 다른 구간은 벽이 겹치지 않을 만큼 떨어져 있다', () => {
    // Every stretch of road lies within 2 m of the straight between its gates: a bot's lane keeps to the road.
    let gate = 0;
    MIDDLE.forEach((point, index) => {
      while (gate + 1 < GATES.length && nearest(GATES[gate + 1]!) <= index) gate++;
      const [from, to] = [GATES[gate]!, GATES[(gate + 1) % GATES.length]!];
      expect(offSegment(point, from, to)).toBeLessThan(2);
    });
    // Two points far apart along the loop are at least the road and its barriers apart on the ground.
    const count = MIDDLE.length;
    for (let a = 0; a < count; a += 3) {
      for (let b = a + 1; b < count; b += 3) {
        const along = Math.min(b - a, count - (b - a)) * 1.5;
        if (along > 60) expect(apart(MIDDLE[a]!, MIDDLE[b]!)).toBeGreaterThan(2 * HALF_WIDTH + 6);
      }
    }
  });

  it('출발 자리 여덟은 출발선 뒤 길 위에 있고, 상자와 부스터도 길 위에 있다', () => {
    const { ahead } = frame(MIDDLE, 0);
    expect(GRID).toHaveLength(8);
    for (const slot of GRID) {
      const behind = (slot[0] - START[0]) * ahead[0] + (slot[1] - START[1]) * ahead[1];
      expect(behind).toBeLessThan(-4);
      expect(apart(slot, MIDDLE[nearest(slot)]!)).toBeLessThan(HALF_WIDTH - 2);
    }
    expect(new Set(GRID.map((slot) => slot.join())).size).toBe(8);
    expect(BOXES.length).toBeLessThanOrEqual(24);
    expect(BOOSTS.length).toBeLessThanOrEqual(24);
    for (const spot of [...BOXES, ...BOOSTS]) expect(apart(spot, MIDDLE[nearest(spot)]!)).toBeLessThan(HALF_WIDTH - 1);
  });

  it('시작 레이아웃은 서버가 받는 모양과 범위 안이고 한 프레임에 들어간다', () => {
    const layout = kartLayout({ session: session(1), options: undefined });
    expect(layout.bots).toBe(3);
    expect(layout.laps).toBe(3);
    expect(layout.radius).toBeGreaterThanOrEqual(2);
    expect(layout.radius).toBeLessThanOrEqual(15);
    expect(layout.grid).toHaveLength(8);
    const points = [...layout.checkpoints, ...layout.grid, ...layout.boxes, ...layout.boosts];
    for (const point of points) {
      expect(point[1]).toBe(ARENA_Y);
      expect(Math.abs(point[0])).toBeLessThanOrEqual(200);
      expect(Math.abs(point[2])).toBeLessThanOrEqual(200);
    }
    const frameText = JSON.stringify({ type: 'Start', layout });
    expect(new TextEncoder().encode(frameText).length).toBeLessThan(16 * 1024);
    // The host's settings, kept within what the server takes.
    expect(kartLayout({ session: session(2), options: { bots: 9, laps: 9 } })).toMatchObject({ bots: 6, laps: 5 });
    expect(kartLayout({ session: session(8), options: { bots: 2, laps: 0 } })).toMatchObject({ bots: 0, laps: 1 });
    expect(kartLayout({ session: session(5), options: undefined })).toMatchObject({ bots: 0, laps: 3 });
  });
});
