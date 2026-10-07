import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MyPet } from '../../api/types';
import { PetBrain } from '../brain/brain';
import { base64ToBytes } from '../brain/codec';
import { BALL_PICKUP_REWARD, LEARNING_IDLE_SECONDS, TREAT_SATIETY } from '../brain/constants';
import { parsePetGraph } from '../brain/graph';
import { breedInfo, PetController, type PetWorldView } from '../controller';
import { FakeBody } from './fakeBody';

const graph = parsePetGraph(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../brain/malecns-dna02-128.json'), 'utf8')));
const BREED = {
  id: 'pug',
  label: '퍼그',
  emoji: '🐶',
  modelUrl: '/gltf/pets/pug.glb',
  thumbnailUrl: '/gltf/pets/pug.webp',
  clips: ['bark', 'idle', 'jump', 'lie', 'run', 'sit', 'walk', 'sit_hold', 'lie_hold'],
  heightM: 0.55,
};
const NOW_MS = Date.UTC(2026, 9, 8, 3);

function myPet(changes: Partial<MyPet> = {}): MyPet {
  return {
    id: '7d3c1f9e-2b4a-4c8e-9f10-123456789abc',
    name: '초코',
    breed: 'pug',
    breedInfo: BREED,
    home: { x: 0, z: 0 },
    seed: 12345,
    graphId: 'malecns-v1.0-dna02-neighborhood-128',
    model: 'pet-brain-v1',
    brain: null,
    drives: {},
    stats: {},
    revision: 1,
    createdAt: new Date(NOW_MS).toISOString(),
    updatedAt: new Date(NOW_MS).toISOString(),
    ...changes,
  };
}

let now = 0;
const idle = (work: () => void) => work();
function setup(changes: Partial<MyPet> = {}) {
  const pet = myPet(changes);
  const brain = PetBrain.create(graph, pet.seed);
  const controller = new PetController({ pet, breed: breedInfo(BREED), brain, clock: () => now, wallClock: () => NOW_MS + now * 1000, idle });
  const body = new FakeBody();
  const world: PetWorldView = {
    owner: () => ({ position: [0, 1, 3], yaw: Math.PI, speed: 0 }),
    visitors: () => [],
    hour: () => 12,
    ground: () => 0,
    walkable: (x, z) => Math.abs(x) < 26 && Math.abs(z) < 26,
  };
  controller.attach(body, world);
  return { pet, brain, controller, body, world };
}

beforeEach(() => {
  now = 100;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('PetController commands and feedback', () => {
  it('starts a trial for a command, ignores the same one again within half a second, and lets it lapse', () => {
    const { brain, controller } = setup();
    const trial = vi.spyOn(brain, 'startTrial');
    expect(controller.command('sit')).toBe(true);
    expect(controller.status().command).toBe('sit');
    now += 0.3;
    expect(controller.command('sit')).toBe(false);
    now += 0.3;
    expect(controller.command('sit')).toBe(true);
    expect(trial).toHaveBeenCalledTimes(2);
    now += 10.1;
    controller.decide();
    expect(controller.status().command).toBeNull();
    expect(controller.saveBody().body.stats.commands?.sit?.given).toBe(2);
  });

  it('rewards the brain for feedback: a treat ends the trial, a pat does not', () => {
    const { brain, controller } = setup();
    const reward = vi.spyOn(brain, 'reward');
    controller.command('sit');
    expect(controller.feedback('pat')).toBe(true);
    expect(reward).toHaveBeenLastCalledWith(0.3, false);
    expect(controller.status().command).toBe('sit');
    const before = controller.status().drives.satiety;
    expect(controller.feedback('treat')).toBe(true);
    const [amount, terminal] = reward.mock.calls.at(-1)!;
    expect(terminal).toBe(true);
    expect(amount).toBeGreaterThan(0.5);
    expect(controller.status().command).toBeNull();
    expect(controller.status().drives.satiety).toBe(before + Math.round(TREAT_SATIETY * 100));
    controller.feedback('scold');
    expect(reward).toHaveBeenLastCalledWith(-0.6, true);
    const stats = controller.saveBody().body.stats;
    expect(stats).toMatchObject({ treats: 1, pats: 1, scolds: 1, praises: 0 });
    // Feedback just after the command ended still counts for it.
    expect(stats.commands?.sit).toMatchObject({ given: 1, treats: 1, scolds: 1 });
  });

  it('turns treats off when the pet is full', () => {
    // Saved as the page opens (`now` is 100 s on the wall clock), so no hunger is caught up first.
    const { controller } = setup({ drives: { energy: 0.8, satiety: 0.9, mood: 0.6, bond: 0.1 }, updatedAt: new Date(NOW_MS + 100_000).toISOString() });
    expect(controller.status().canTreat).toBe(true);
    expect(controller.feedback('treat')).toBe(true);
    expect(controller.status().canTreat).toBe(false);
    expect(controller.feedback('treat')).toBe(false);
  });

  it('takes commands, praise and "안돼" from the owner’s chat, with or without its name', () => {
    const { brain, controller } = setup();
    const reward = vi.spyOn(brain, 'reward');
    expect(controller.chat('초코 앉아')).toBe(true);
    expect(controller.status().command).toBe('sit');
    expect(controller.chat('잘했어!')).toBe(true);
    expect(reward).toHaveBeenLastCalledWith(0.5, true);
    expect(controller.chat('앉아서 쉬자')).toBe(false);
    now += 1;
    expect(controller.chat('엎드려')).toBe(true);
    expect(controller.status().command).toBe('down');
  });

  it('throws the ball for 공 던지기 and keeps the fetch command until the ball is back', () => {
    const { brain, controller } = setup();
    const reward = vi.spyOn(brain, 'reward');
    expect(controller.throwBall()).toBe(true);
    expect(controller.status().command).toBe('fetch');
    expect(controller.bodyMotor?.ball?.flight).not.toBeNull();
    now += 60;
    controller.decide();
    expect(controller.status().command).toBe('fetch');
    controller.bodyMotor!.clearBall();
    controller.decide();
    expect(controller.status().command).toBeNull();
    expect(reward).not.toHaveBeenCalledWith(BALL_PICKUP_REWARD);
  });
});

describe('PetController learning and decisions', () => {
  it('learns only while the owner trains it, on show, not decorating, away, refused or relayed elsewhere', () => {
    const { brain, controller } = setup();
    const decide = vi.spyOn(brain, 'decide');
    const learning = () => decide.mock.calls.at(-1)![1].learning;
    controller.decide();
    expect(learning()).toBe(false);
    controller.command('sit');
    controller.decide();
    expect(learning()).toBe(true);
    expect(controller.status().learning).toBe(true);
    for (const condition of ['hidden', 'conflict', 'busy'] as const) {
      controller.setConditions({ [condition]: true });
      controller.decide();
      expect(learning(), condition).toBe(false);
      controller.setConditions({ [condition]: false });
    }
    now += LEARNING_IDLE_SECONDS + 1;
    controller.decide();
    expect(learning()).toBe(false);
  });

  it('turns the brain’s choice into the body’s actions, holding a posture it is in', () => {
    const { brain, controller, body } = setup();
    vi.spyOn(brain, 'decide').mockReturnValue({ action: 'sit', explored: false });
    const decision = controller.decide();
    expect(decision?.actions).toEqual([{ type: 'idle', animationId: 'sit_hold' }]);
    body.act(decision!.actions);
    for (let i = 0; i < 40; i++) controller.tick(1 / 30);
    expect(body.gestures).toContain('sit');
    expect(controller.status().activity).toBe('sit');
    // The next decision is told what the pet is holding.
    controller.decide();
    expect(vi.mocked(brain.decide).mock.calls.at(-1)![1].current).toBe('sit');
  });

  it('stands at home while the owner decorates and waits sitting while they are away', () => {
    const { controller, body } = setup({ home: { x: 4, z: -2 } });
    body.position = [1, 0, 1];
    controller.setConditions({ decorating: true });
    const held = controller.decide();
    expect(held?.actions).toEqual([]);
    expect(body.placed.at(-1)).toEqual([4, 0, -2]);
    expect(controller.decide()).toBeUndefined();
    controller.setConditions({ decorating: false, away: true });
    expect(controller.decide()?.actions).toEqual([{ type: 'idle', animationId: 'sit_hold' }]);
    expect(controller.command('come')).toBe(true);
    expect(controller.throwBall()).toBe(false);
  });
});

describe('PetController saving', () => {
  it('saves the brain, the four drives and counts in the shapes the server checks', () => {
    const { controller } = setup();
    expect(controller.changed()).toBe(false);
    controller.command('come');
    controller.feedback('praise');
    expect(controller.changed()).toBe(true);
    const { body, mark } = controller.saveBody();
    expect(body.brain).toHaveLength(6912);
    expect(base64ToBytes(body.brain)).toHaveLength(5184);
    expect(Object.keys(body.drives).sort()).toEqual(['bond', 'energy', 'mood', 'satiety']);
    for (const value of Object.values(body.drives)) expect(value >= 0 && value <= 1).toBe(true);
    expect(body.stats).toMatchObject({ praises: 1, bondDay: expect.any(Number), bondGainedMilli: 10 });
    for (const [command, counts] of Object.entries(body.stats.commands ?? {})) {
      expect(['come', 'sit', 'down', 'stay', 'fetch', 'speak', 'jump']).toContain(command);
      for (const [key, value] of Object.entries(counts)) {
        expect(['given', 'treats', 'praises', 'scolds', 'mastery']).toContain(key);
        expect(Number.isInteger(value) && value >= 0 && value <= (key === 'mastery' ? 100 : 1_000_000)).toBe(true);
      }
    }
    controller.markSaved(mark);
    expect(controller.changed()).toBe(false);
  });

  it('loads a saved brain and catches the drives up on the time away', () => {
    const trained = PetBrain.create(graph, 12345);
    const saved = myPet({
      drives: { energy: 0.2, satiety: 0.9, mood: 0.6, bond: 0.4 },
      updatedAt: new Date(NOW_MS - 3600_000).toISOString(),
      stats: { bondDay: 99, bondGainedMilli: 150, commands: { sit: { given: 4, mastery: 55 } } },
    });
    const controller = new PetController({ pet: saved, breed: breedInfo(BREED), brain: trained, clock: () => now, wallClock: () => NOW_MS, idle });
    const { drives, mastery } = controller.status();
    expect(drives.energy).toBe(100);
    expect(drives.satiety).toBeLessThan(90);
    expect(drives.bond).toBe(40);
    expect(mastery?.sit).toBe(55);
  });

  it('measures mastery after feedback, in idle time', () => {
    const { controller } = setup();
    controller.command('sit');
    controller.feedback('treat');
    vi.advanceTimersByTime(5000);
    const mastery = controller.status().mastery!;
    for (const value of Object.values(mastery)) expect(Number.isInteger(value) && value >= 0 && value <= 100).toBe(true);
  });
});

describe('breedInfo', () => {
  it('measures the walk and the run of a shipped dog apart, at island scale', () => {
    const breeds = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../breeds.json'), 'utf8')) as
      { slug: string; stride_mps: { walk: number; run: number } }[];
    const pug = breeds.find((breed) => breed.slug === 'pug')!;
    const info = breedInfo(BREED);
    expect(info.strideSpeed).toBeCloseTo(pug.stride_mps.walk * 1.5, 6);
    expect(info.runStrideSpeed).toBeCloseTo(pug.stride_mps.run * 1.5, 6);
    expect(info.runStrideSpeed).toBeGreaterThan(info.strideSpeed);
  });
});
