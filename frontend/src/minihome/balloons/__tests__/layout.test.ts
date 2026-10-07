import { describe, expect, it } from 'vitest';

import { stackBalloons, type BalloonBox } from '../layout';

const box = (id: string, x: number, y: number, distance: number, width = 120, height = 40): BalloonBox => ({
  id,
  x,
  y,
  width,
  height,
  distance,
});
const bottom = (item: BalloonBox, lifts: Map<string, number>) => item.y - lifts.get(item.id)!;
const top = (item: BalloonBox, lifts: Map<string, number>) => bottom(item, lifts) - item.height;

describe('말풍선 쌓기', () => {
  it('겹치지 않는 말풍선은 제자리에 둔다', () => {
    const lifts = stackBalloons([box('a', 100, 300, 10), box('b', 400, 300, 12), box('c', 100, 500, 14)]);
    expect([...lifts.values()]).toEqual([0, 0, 0]);
  });

  it('겹치면 가까운 것은 두고 먼 것을 그 위로 올린다(넘겨 준 순서와 상관없이)', () => {
    const near = box('near', 200, 300, 10);
    const far = box('far', 230, 310, 16);
    for (const order of [[near, far], [far, near]]) {
      const lifts = stackBalloons(order);
      expect(lifts.get('near')).toBe(0);
      expect(bottom(far, lifts)).toBeLessThanOrEqual(top(near, lifts) - 4);
    }
  });

  it('올린 자리에서 또 겹치면 그 위로 다시 올려, 셋이 차례로 쌓인다', () => {
    const items = [box('a', 200, 300, 10), box('b', 205, 300, 11), box('c', 210, 300, 12)];
    const lifts = stackBalloons(items);
    expect(top(items[0]!, lifts)).toBeGreaterThanOrEqual(bottom(items[1]!, lifts) + 4);
    expect(top(items[1]!, lifts)).toBeGreaterThanOrEqual(bottom(items[2]!, lifts) + 4);
    expect(lifts.get('c')).toBeGreaterThan(lifts.get('b')!);
  });

  it('비켜 선 말풍선은 높이가 같아도 올리지 않는다', () => {
    const lifts = stackBalloons([box('a', 100, 300, 10, 120), box('b', 221, 300, 11, 120)]);
    expect(lifts.get('b')).toBe(0);
  });
});
