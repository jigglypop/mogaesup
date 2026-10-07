import { describe, expect, it, vi } from 'vitest';

import { readPetFrame, readServerMessage, type PetFrame } from '../../games/protocol';
import { PetMotor } from '../motor';
import { LOST_SECONDS, PetPuppet, PetRelaySender, petFrame } from '../relay';
import { FakeBody, MOTION, surroundings } from './fakeBody';

const ID = '7d3c1f9e-2b4a-4c8e-9f10-123456789abc';
const frame = (changes: Partial<PetFrame> = {}): PetFrame => ({
  id: ID,
  t: 100,
  at: [3.2, 0.1, -4],
  ry: 1.57,
  move: true,
  speed: 3,
  clip: 'walk',
  gesture: null,
  ball: { at: [5, 0.15, -2], held: false },
  ...changes,
});

describe('pet frames on the game socket', () => {
  it('reads the frames the server relays and refuses what it would refuse', () => {
    const raw = JSON.stringify({ type: 'Pet', pet: frame({ gesture: { clip: 'bark', at: 12.5 } }) });
    expect(readServerMessage(raw)).toEqual({ type: 'Pet', pet: frame({ gesture: { clip: 'bark', at: 12.5 } }) });
    expect(readServerMessage(JSON.stringify({ type: 'Pet', pet: null }))).toEqual({ type: 'Pet', pet: null });
    for (const wrong of [
      { id: 'pet' },
      { t: 'now' },
      { at: [200.5, 0, 0] },
      { at: [0, -50.5, 0] },
      { at: [0, 300.5, 0] },
      { at: [0, 0] },
      { ry: null },
      { move: 1 },
      { speed: 30.5 },
      { speed: -1 },
      { clip: 'dance' },
      { gesture: { clip: 'walk', at: 1 } },
      { gesture: { clip: 'bark' } },
      { ball: { at: [0, 0, 201], held: false } },
      { ball: { at: [0, 0, 0] } },
    ]) {
      expect(readPetFrame({ ...frame(), ...wrong }), JSON.stringify(wrong)).toBeNull();
      expect(readServerMessage(JSON.stringify({ type: 'Pet', pet: { ...frame(), ...wrong } }))).toBeNull();
    }
    const extra = readPetFrame({ ...frame(), note: 'dropped', ball: undefined });
    expect(extra).toEqual(frame({ ball: null }));
  });

  it('makes frames of the motor and its body, small enough for the server', () => {
    const body = new FakeBody();
    body.position = [1.23456, 0, -2.5];
    const motor = new PetMotor(body, MOTION, 1);
    const world = surroundings({ owner: { position: [0, 1, 12], yaw: 0, speed: 0 } });
    body.act(motor.plan('come', world));
    const moving = petFrame(ID, 12.3456, body, motor)!;
    expect(moving).toMatchObject({ id: ID, t: 12.35, at: [1.235, 0, -2.5], move: true, clip: 'run' });
    expect(moving.speed).toBeGreaterThan(0);
    expect(readPetFrame(moving)).toEqual(moving);
    body.act(motor.plan('sit', world));
    for (let i = 0; i < 20; i++) motor.tick(1 / 30, world);
    const sitting = petFrame(ID, 13, body, motor)!;
    expect(sitting).toMatchObject({ move: false, speed: 0, clip: 'sit_hold', gesture: { clip: 'sit' } });
    expect(JSON.stringify({ type: 'Pet', pet: sitting }).length).toBeLessThan(512);
  });
});

describe('PetRelaySender', () => {
  it('sends five a second while moving, once a second standing, and soon after a change', () => {
    const send = vi.fn(() => true);
    const sender = new PetRelaySender(send);
    const times: number[] = [];
    for (let t = 0; t <= 1.001; t += 1 / 60) if (sender.offer(t, frame({ t }))) times.push(Math.round(t * 100) / 100);
    expect(times).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    send.mockClear();
    const still = frame({ move: false, speed: 0, clip: 'idle' });
    let sent = 0;
    for (let t = 1.2; t < 3.15; t += 1 / 60) if (sender.offer(t, { ...still, t })) sent++;
    expect(sent).toBe(2);
    const barked = { ...still, gesture: { clip: 'bark' as const, at: 3.1 } };
    expect(sender.offer(3.15, barked)).toBe(true);
    expect(sender.offer(3.3, { ...barked, ball: null })).toBe(true);
    expect(sender.offer(3.35, { ...barked, ball: null })).toBe(false);
  });

  it('sends ten a second while the ball flies, and lets go once', () => {
    const send = vi.fn((_pet: unknown) => true);
    const sender = new PetRelaySender(send);
    let sent = 0;
    for (let t = 0; t < 0.999; t += 1 / 60) if (sender.offer(t, frame({ move: false, speed: 0, clip: 'idle' }), true)) sent++;
    expect(sent).toBe(10);
    sender.letGo();
    sender.letGo();
    expect(send).toHaveBeenLastCalledWith(null);
    expect(send.mock.calls.filter(([pet]) => pet === null)).toHaveLength(1);
  });

  it('tries again next frame when the socket was down', () => {
    let up = false;
    const sender = new PetRelaySender(() => up);
    expect(sender.offer(0, frame())).toBe(false);
    up = true;
    expect(sender.offer(0.02, frame())).toBe(true);
  });
});

describe("PetPuppet (a visitor's pet)", () => {
  const setup = () => {
    const body = new FakeBody();
    body.position = [0, 0, 0];
    const rest = vi.fn();
    const puppet = new PetPuppet(body, MOTION, [0, 0, 0], rest);
    return { body, rest, puppet };
  };

  it('jumps to a far frame, then walks a little ahead of where the pet is going', () => {
    const { body, puppet, rest } = setup();
    puppet.apply(frame({ at: [10, 0, 0], ry: 0, speed: 4, clip: 'run' }));
    expect(body.placed).toEqual([[10, 0, 0]]);
    expect(rest).toHaveBeenCalledWith(false);
    expect(body.route).toEqual({ target: [10, 0, 1.2], speed: 4.2, clip: 'run' });
    const plans = body.acted.length;
    puppet.apply(frame({ t: 100.2, at: [10, 0, 0.1], ry: 0, speed: 4, clip: 'run' }));
    expect(body.acted.length).toBe(plans);
    puppet.apply(frame({ t: 100.4, at: [10, 0, 0.8], ry: 0, speed: 4, clip: 'run' }));
    expect(body.route?.target[2]).toBeCloseTo(2, 5);
  });

  it('takes the posture a still frame names, leading in only for a fresh sit', () => {
    const { body, puppet } = setup();
    // Joining while the pet already sits: straight to the hold, the old gesture not played again.
    puppet.apply(frame({ at: [0, 0, 0], move: false, speed: 0, clip: 'sit_hold', gesture: { clip: 'sit', at: 50 } }));
    for (let i = 0; i < 60; i++) puppet.tick(1 / 30);
    expect(body.idleClip).toBe('sit_hold');
    expect(body.gestures).toEqual([]);
    puppet.apply(frame({ t: 101, at: [0, 0, 0], move: false, speed: 0, clip: 'idle', gesture: { clip: 'sit', at: 50 } }));
    expect(body.idleClip).toBe('idle');
    puppet.apply(frame({ t: 102, at: [0, 0, 0], move: false, speed: 0, clip: 'lie_hold', gesture: { clip: 'lie', at: 60 } }));
    for (let i = 0; i < 60; i++) puppet.tick(1 / 30);
    expect(body.gestures).toEqual(['lie', 'lie_hold']);
    expect(body.idleClip).toBe('lie_hold');
  });

  it('plays each bark once, however many frames carry it', () => {
    const { body, puppet } = setup();
    const still = { at: [0, 0, 0] as [number, number, number], move: false, speed: 0, clip: 'idle' as const };
    puppet.apply(frame({ ...still, t: 1, gesture: null }));
    puppet.apply(frame({ ...still, t: 2, gesture: { clip: 'bark', at: 1.5 } }));
    for (let i = 0; i < 20; i++) puppet.tick(1 / 30);
    puppet.apply(frame({ ...still, t: 3, gesture: { clip: 'bark', at: 1.5 } }));
    for (let i = 0; i < 20; i++) puppet.tick(1 / 30);
    expect(body.gestures).toEqual(['bark']);
    // An older frame arriving late changes nothing; the owner's page starting over (a much older clock) does.
    puppet.apply(frame({ ...still, t: 2.5, gesture: { clip: 'bark', at: 9 } }));
    for (let i = 0; i < 20; i++) puppet.tick(1 / 30);
    expect(body.gestures).toEqual(['bark']);
    puppet.apply(frame({ ...still, t: 0.1, gesture: { clip: 'jump', at: 0.05 } }));
    for (let i = 0; i < 20; i++) puppet.tick(1 / 30);
    expect(body.gestures).toEqual(['bark', 'jump']);
  });

  it('walks home and lies down when the owner lets go, or when frames stop coming', () => {
    const { body, puppet, rest } = setup();
    puppet.apply(frame({ at: [3, 0, 0], move: false, speed: 0, clip: 'idle' }));
    expect(puppet.relayed).toBe(true);
    for (let i = 0; i < 60; i++) {
      body.step(1 / 30);
      puppet.tick(1 / 30);
    }
    expect(body.position).toEqual([3, 0, 0]);
    puppet.apply(null);
    expect(puppet.relayed).toBe(false);
    expect(body.route?.target).toEqual([0, 0, 0]);
    for (let i = 0; i < 90; i++) {
      body.step(1 / 30);
      puppet.tick(1 / 30);
    }
    expect(body.idleClip).toBe('lie_hold');
    expect(rest).toHaveBeenLastCalledWith(true);

    puppet.apply(frame({ t: 200, at: [2, 0, 0], move: false, speed: 0, clip: 'idle' }));
    for (let t = 0; t < LOST_SECONDS + 1; t += 1 / 30) {
      body.step(1 / 30);
      puppet.tick(1 / 30);
    }
    expect(puppet.relayed).toBe(false);
    expect(body.position).toEqual([0, 0, 0]);
  });

  it('draws the ball where the frames put it, in the mouth while held', () => {
    const { body, puppet } = setup();
    puppet.apply(frame({ at: [0, 0, 0], ry: 0, move: false, speed: 0, clip: 'idle', ball: { at: [2, 0.1, 0], held: false } }));
    puppet.tick(1 / 30);
    expect(puppet.ball?.at).toEqual([2, 0.1, 0]);
    puppet.apply(frame({ t: 101, at: [0, 0, 0], ry: 0, move: false, speed: 0, clip: 'idle', ball: { at: [0, 0.5, 0.4], held: true } }));
    puppet.tick(1 / 30);
    expect(puppet.ball).toEqual({ held: true, at: [0, 0.45, 0.4] });
    puppet.apply(frame({ t: 102, at: [0, 0, 0], move: false, speed: 0, clip: 'idle', ball: null }));
    expect(puppet.ball).toBeNull();
    void body;
  });
});
