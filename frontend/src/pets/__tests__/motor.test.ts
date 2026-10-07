import { describe, expect, it, vi } from 'vitest';

import { BALL_PICKUP_REWARD, GREET_REWARD } from '../brain/constants';
import { PetMotor, type Surroundings } from '../motor';
import { FakeBody, MOTION, surroundings } from './fakeBody';

/** Runs the motor (and the body's route) for `seconds` in frames of 1/30 s. */
function run(motor: PetMotor, body: FakeBody, world: Surroundings, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 30) {
    body.step(1 / 30);
    motor.tick(1 / 30, world);
  }
}
const decide = (motor: PetMotor, body: FakeBody, action: Parameters<PetMotor['plan']>[0], world: Surroundings) => {
  const actions = motor.plan(action, world);
  body.act(actions);
  return actions;
};

describe('PetMotor postures', () => {
  it('sits with the one-shot clip, then holds sit_hold once it is down', () => {
    const body = new FakeBody();
    const motor = new PetMotor(body, MOTION, 7);
    const world = surroundings();
    const actions = decide(motor, body, 'sit', world);
    expect(actions).toEqual([{ type: 'idle', animationId: 'sit_hold' }]);
    run(motor, body, world, 0.3);
    expect(body.gestures).toEqual(['sit']);
    expect(motor.pose.lastGesture?.clip).toBe('sit');
    run(motor, body, world, 1.0);
    // The one-shot (down, hold, up) gives way to its hold before it would stand up.
    expect(body.gestures).toEqual(['sit', 'sit_hold']);
    expect(motor.pose.stillClip()).toBe('sit_hold');
    expect(motor.current(0.8)).toBe('sit');
    expect(motor.activity(false, 0.8)).toBe('sit');
    // Sitting again changes nothing.
    expect(decide(motor, body, 'sit', world)).toEqual([]);
  });

  it('lies down from a sit by blending holds, and stands up with idle', () => {
    const body = new FakeBody();
    const motor = new PetMotor(body, MOTION, 7);
    const world = surroundings();
    decide(motor, body, 'sit', world);
    run(motor, body, world, 1.5);
    body.gestures = [];
    expect(decide(motor, body, 'down', world)).toEqual([{ type: 'idle', animationId: 'lie_hold' }]);
    run(motor, body, world, 1.5);
    expect(body.gestures).toEqual([]);
    expect(motor.pose.stillClip()).toBe('lie_hold');
    expect(decide(motor, body, 'stand', world)).toEqual([{ type: 'idle', animationId: 'idle' }]);
    expect(motor.current(0.8)).toBeNull();
  });

  it('waits for the body to stop before a gesture (the engine skips gestures while moving)', () => {
    const body = new FakeBody();
    const motor = new PetMotor(body, MOTION, 7);
    const world = surroundings({ owner: { position: [0, 1, 10], yaw: 0, speed: 0 } });
    decide(motor, body, 'come', world);
    expect(body.moving()).toBe(true);
    const actions = decide(motor, body, 'speak', world);
    expect(actions[0]).toEqual({ type: 'idle', animationId: 'idle' });
    expect(body.moving()).toBe(false);
    motor.tick(1 / 30, world);
    expect(body.gestures).toEqual([]);
    run(motor, body, world, 0.5);
    expect(body.gestures).toEqual(['bark']);
    expect(motor.current(0.8)).toBe('speak');
    run(motor, body, world, 1.5);
    expect(motor.current(0.8)).toBeNull();
  });

  it('falls back to the one-shot sit for a model without hold clips', () => {
    const body = new FakeBody();
    const motor = new PetMotor(body, { ...MOTION, clips: new Set(['idle', 'walk', 'sit', 'lie']) }, 7);
    const world = surroundings();
    expect(decide(motor, body, 'sit', world)).toEqual([{ type: 'idle', animationId: 'idle' }]);
    run(motor, body, world, 2);
    expect(body.gestures).toEqual(['sit']);
    expect(motor.pose.stillClip()).toBe('sit');
    expect(motor.activity(false, 0.8)).toBe('sit');
  });
});

describe('PetMotor coming and following', () => {
  it('comes to 1.8 m from the owner, faster the farther it is', () => {
    const body = new FakeBody();
    const motor = new PetMotor(body, MOTION, 7);
    const world = surroundings({ owner: { position: [0, 1, 10], yaw: Math.PI, speed: 0 } });
    const [move] = decide(motor, body, 'come', world).filter((action) => action.type === 'moveTo');
    expect(move).toMatchObject({ type: 'moveTo', animationId: 'run' });
    if (move?.type !== 'moveTo') throw new Error('no move');
    expect(move.target[2]).toBeCloseTo(8.2, 5);
    expect(move.target[1]).toBe(0);
    expect(move.speed).toBeGreaterThanOrEqual(3);
    expect(move.speed).toBeLessThanOrEqual(7);
    expect(motor.current(0.8)).toBe('come');
    run(motor, body, world, 3);
    expect(motor.current(0.8)).toBeNull();
    expect(body.faced.at(-1)).toEqual([0, 1, 10]);
  });

  it('keeps up with an owner running away, and appears behind one past 25 m', () => {
    const body = new FakeBody();
    const motor = new PetMotor(body, MOTION, 7);
    const running = surroundings({ owner: { position: [0, 1, 12], yaw: 0, speed: 10 } });
    const [move] = decide(motor, body, 'come', running).filter((action) => action.type === 'moveTo');
    if (move?.type !== 'moveTo') throw new Error('no move');
    expect(move.speed).toBeCloseTo(11, 5);
    const far = surroundings({ owner: { position: [0, 1, 40], yaw: 0, speed: 0 }, walkable: () => true });
    decide(motor, body, 'come', far);
    expect(body.placed.at(-1)).toEqual([0, 0, 38.5]);
    // Behind the owner is not open ground: beside them.
    const edge = surroundings({ owner: { position: [0, 1, 40], yaw: 0, speed: 0 }, walkable: (x) => x > 1 });
    body.position = [0, 0, 0];
    decide(motor, body, 'stand', edge);
    decide(motor, body, 'come', edge);
    expect(body.placed.at(-1)).toEqual([1.5, 0, 40]);
  });

  it('plans a route again only when the goal moved', () => {
    const body = new FakeBody();
    const motor = new PetMotor(body, MOTION, 7);
    const world = surroundings({ owner: { position: [0, 1, 10], yaw: 0, speed: 0 } });
    expect(decide(motor, body, 'come', world).length).toBeGreaterThan(0);
    expect(decide(motor, body, 'come', world)).toEqual([]);
    const moved = surroundings({ owner: { position: [3, 1, 10], yaw: 0, speed: 0 } });
    expect(decide(motor, body, 'come', moved).some((action) => action.type === 'moveTo')).toBe(true);
  });

  it('walks home to rest and lies down there; sleeps at night when tired', () => {
    const body = new FakeBody();
    body.position = [4, 0, 0];
    const motor = new PetMotor(body, MOTION, 7);
    const world = surroundings({ home: [0, 0, 0], night: true, energy: 0.2 });
    decide(motor, body, 'rest', world);
    expect(body.route?.target).toEqual([0, 0, 0]);
    expect(motor.current(0.2)).toBe('rest');
    run(motor, body, world, 3);
    expect(body.idleClip).toBe('lie_hold');
    expect(body.gestures).toContain('lie');
    expect(motor.activity(true, 0.2)).toBe('sleep');
    expect(motor.activity(false, 0.2)).toBe('rest');
    expect(motor.current(0.2)).toBe('rest');
    expect(motor.current(0.96)).toBeNull();
  });
});

describe('PetMotor fetch, greeting and exploring', () => {
  it('fetches a thrown ball: runs to where it lands, picks it up, brings it to the owner', () => {
    const body = new FakeBody();
    const reward = vi.fn();
    const returned = vi.fn();
    const motor = new PetMotor(body, MOTION, 7, { reward, returned });
    const world = surroundings({ owner: { position: [0, 1, 1], yaw: 0, speed: 0 } });
    expect(motor.throwBall(world)).toBe(true);
    const ball = motor.ball!;
    expect(ball.flight).not.toBeNull();
    expect(motor.ballDistance()).toBeNull();
    decide(motor, body, 'fetch', world);
    expect(body.route?.target).toEqual(ball.flight!.to);
    for (let i = 0; i < 30 * 8 && !motor.carrying; i++) run(motor, body, world, 1 / 30);
    expect(motor.carrying).toBe(true);
    expect(reward).toHaveBeenCalledWith(BALL_PICKUP_REWARD);
    expect(motor.activity(false, 0.8)).toBe('fetchBack');
    expect(motor.current(0.8)).toBe('fetch');
    for (let i = 0; i < 30 * 8 && motor.ball; i++) run(motor, body, world, 1 / 30);
    expect(motor.ball).toBeNull();
    expect(returned).toHaveBeenCalledTimes(1);
    expect(Math.hypot(body.position[0], body.position[2] - 1)).toBeLessThan(2.8);
  });

  it('drops the ball where it is when it turns to something else', () => {
    const body = new FakeBody();
    const motor = new PetMotor(body, MOTION, 7);
    const world = surroundings();
    motor.throwBall(world);
    motor.ball!.held = true;
    motor.ball!.flight = null;
    decide(motor, body, 'sit', world);
    expect(motor.ball?.held).toBe(false);
    expect(motor.ballDistance()).toBeCloseTo(0.4, 5);
  });

  it('greets a visitor: goes to them, jumps once there, and is paid once', () => {
    const body = new FakeBody();
    const reward = vi.fn();
    const motor = new PetMotor(body, MOTION, 7, { reward });
    const world = surroundings({ visitor: { id: 'peer', position: [6, 1, 0] } });
    decide(motor, body, 'greet', world);
    expect(motor.current(0.8)).toBe('greet');
    run(motor, body, world, 3);
    expect(reward).toHaveBeenCalledWith(GREET_REWARD);
    expect(reward).toHaveBeenCalledTimes(1);
    expect(body.gestures).toContain('jump');
    expect(motor.current(0.8)).toBeNull();
  });

  it('explores open ground within 5 m of home, the same way for the same seed', () => {
    const targets = (seed: number) => {
      const body = new FakeBody();
      const motor = new PetMotor(body, MOTION, seed);
      const world = surroundings({ home: [2, 0, 2], walkable: (x) => x > 0 });
      const found: number[][] = [];
      for (let i = 0; i < 5; i++) {
        decide(motor, body, 'explore', world);
        found.push([...body.route!.target]);
        run(motor, body, world, 10);
      }
      return found;
    };
    const first = targets(3);
    for (const [x, , z] of first) {
      expect(Math.hypot(x! - 2, z! - 2)).toBeLessThanOrEqual(5);
      expect(x).toBeGreaterThan(0);
    }
    expect(targets(3)).toEqual(first);
  });
});
