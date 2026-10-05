import { describe, expect, it } from 'vitest';

import { afterContact, KART, kartVelocity, NEUTRAL, readKeys, startKart, stepKart, type KartInput, type KartState } from '../kart/physics';

const GO: KartInput = { throttle: 1, steer: 0, drift: false };
const free = (now = 0) => ({ now, boosted: false, held: false });

/** `seconds` of `input` at 60 frames a second from `state`, the page's clock running from `now`. */
function drive(state: KartState, input: KartInput, seconds: number, now = 0, boosted = false): KartState {
  let at = state;
  for (let frame = 0; frame < Math.round(seconds * 60); frame++) at = stepKart(at, input, 1 / 60, { now: now + (frame * 1000) / 60, boosted, held: false });
  return at;
}

describe('카트 움직임', () => {
  it('가속하면 최고 속도까지, 놓으면 서서히, 브레이크면 빨리 서고 뒤로도 간다', () => {
    const fast = drive(startKart(0), GO, 4);
    expect(fast.speed).toBe(KART.top);
    expect(kartVelocity(fast)[1]).toBeCloseTo(KART.top);
    const rolling = drive(fast, NEUTRAL, 1);
    expect(rolling.speed).toBeCloseTo(KART.top - KART.roll, 5);
    const braked = drive(fast, { throttle: -1, steer: 0, drift: false }, 0.5);
    expect(braked.speed).toBeLessThan(10);
    const back = drive(startKart(0), { throttle: -1, steer: 0, drift: false }, 3);
    expect(back.speed).toBe(-KART.reverse);
    expect(kartVelocity(back)[1]).toBeLessThan(0);
  });

  it('오른쪽으로 꺾으면 위에서 보아 시계 방향으로 돌고, 서 있으면 돌지 않는다', () => {
    expect(drive(startKart(0), { throttle: 0, steer: 1, drift: false }, 1).heading).toBe(0);
    const right = drive(drive(startKart(0), GO, 2), { throttle: 1, steer: 1, drift: false }, 0.5);
    expect(right.heading).toBeLessThan(-0.5);
    // Facing +z and turning right, it heads toward −x.
    expect(kartVelocity(right)[0]).toBeLessThan(0);
    const left = drive(drive(startKart(0), GO, 2), { throttle: 1, steer: -1, drift: false }, 0.5);
    expect(left.heading).toBeCloseTo(-right.heading, 5);
  });

  it('드리프트는 더 크게 돌며 미끄러지고, 0.6초 넘게 하고 놓으면 잠깐 더 빨라진다', () => {
    const fast = drive(startKart(0), GO, 3);
    const turning = drive(fast, { throttle: 1, steer: 1, drift: false }, 0.5);
    const drifting = drive(fast, { throttle: 1, steer: 1, drift: true }, 0.5);
    expect(drifting.drifting).toBe(true);
    expect(drifting.heading).toBeLessThan(turning.heading);
    expect(drifting.slip).toBeGreaterThan(0.3);
    // Let go after 0.5 s: no boost.
    const short = stepKart(drifting, GO, 1 / 60, free(500));
    expect([short.drifting, short.turboUntil]).toEqual([false, 0]);
    // Let go after 0.8 s: a boost above the top speed for a moment.
    const long = drive(fast, { throttle: 1, steer: 1, drift: true }, 0.8);
    const released = stepKart(long, GO, 1 / 60, free(1_000));
    expect(released.turboUntil).toBe(1_000 + KART.turboFor);
    const boosted = drive(released, GO, 0.5, 1_000);
    expect(boosted.speed).toBeGreaterThan(KART.top + 2);
    expect(drive(boosted, GO, 2, 1_500).speed).toBe(KART.top);
    // Too slow, no drift.
    expect(drive(startKart(0), { throttle: 1, steer: 1, drift: true }, 0.3).drifting).toBe(false);
  });

  it('부스터는 키와 상관없이 밀어 주고, 물풍선과 출발 전에는 멈춰 있다', () => {
    const boosted = drive(startKart(0), NEUTRAL, 1.5, 0, true);
    expect(boosted.speed).toBe(KART.boost);
    const held = stepKart(boosted, GO, 1 / 60, { now: 0, boosted: true, held: true });
    expect(held.speed).toBe(0);
    expect(kartVelocity(held)).toEqual([0, 0]);
  });

  it('벽에 막히면 실제로 간 만큼으로 줄고, 감쇠 정도의 차이는 그대로 둔다', () => {
    expect(afterContact(20, 19.4)).toBe(20);
    expect(afterContact(20, 3)).toBe(3);
    expect(afterContact(20, -2)).toBe(0);
    expect(afterContact(-6, -1)).toBe(-1);
    expect(afterContact(0, 5)).toBe(0);
  });

  it('WASD와 화살표, Shift를 읽는다', () => {
    expect(readKeys(new Set(['KeyW', 'KeyD']))).toEqual({ throttle: 1, steer: 1, drift: false });
    expect(readKeys(new Set(['ArrowDown', 'ArrowLeft', 'ShiftLeft']))).toEqual({ throttle: -1, steer: -1, drift: true });
    expect(readKeys(new Set(['KeyW', 'KeyS', 'KeyA', 'ArrowRight']))).toEqual({ throttle: 0, steer: 0, drift: false });
  });
});
