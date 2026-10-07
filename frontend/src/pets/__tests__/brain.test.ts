import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PetBrain } from '../brain/brain';
import { BRAIN_HEADER_BYTES } from '../brain/codec';
import { parsePetGraph, type PetGraph } from '../brain/graph';
import { intrinsicReward } from '../brain/innate';
import { probeContexts } from '../brain/probes';
import { Random } from '../brain/random';
import {
  ACTION,
  ACTIONS,
  ACTION_COUNT,
  COMMANDS,
  SENSE,
  SENSES,
  bearing,
  cueOf,
  isNight,
  legalActions,
  sense,
  type PetAction,
  type SenseInput,
} from '../brain/senses';
import { train } from '../brain/trainer';

const graph = parsePetGraph(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../brain/malecns-dna02-128.json'), 'utf8')));
/** The circuit with every connection removed, under the same id so a saved readout can be moved onto it. */
const noConnections: PetGraph = { ...graph, weights: new Float32Array(graph.weights.length) };

/** A fixed stream of varied situations (owner near and far, each command or none, visitors, ball, night, drives). */
function situations(count: number, seed = 20261007): SenseInput[] {
  const rng = new Random(seed);
  return Array.from({ length: count }, () => ({
    ownerDistance: rng.range(0.5, 15),
    ownerBearing: rng.range(-Math.PI, Math.PI),
    ownerSpeed: rng.next() < 0.6 ? 0 : rng.range(0, 6),
    command: rng.next() < 0.4 ? null : COMMANDS[rng.int(COMMANDS.length)]!,
    ballDistance: rng.next() < 0.3 ? rng.range(0, 12) : null,
    visitorDistance: rng.next() < 0.3 ? rng.range(0, 10) : null,
    visitorNew: rng.next() < 0.5,
    energy: rng.next(),
    satiety: rng.next(),
    sinceInteraction: rng.range(0, 300),
    night: rng.next() < 0.2,
  }));
}
const readout = (brain: PetBrain) => brain.encode().slice(BRAIN_HEADER_BYTES);
const decideAll = (brain: PetBrain, inputs: SenseInput[], learning: boolean) =>
  inputs.map((input) => {
    const values = sense(input);
    const decision = brain.decide(values, { learning, legal: legalActions(values), current: null });
    brain.reward(intrinsicReward(decision.action, values) + (decision.action === 'sit' ? 0.5 : 0), decision.action === 'speak');
    return decision;
  });

describe('펫 뇌', () => {
  it('활동은 유한하고 크기 1을 넘지 않는다', () => {
    const brain = PetBrain.create(graph, 1);
    for (const input of situations(400)) {
      const values = sense(input);
      brain.decide(values, { learning: true, legal: legalActions(values), current: null });
      const activity = brain.readActivity();
      expect(activity.every((value) => Number.isFinite(value) && Math.abs(value) <= 1)).toBe(true);
    }
    expect(brain.readActivity().some((value) => value !== 0)).toBe(true);
  });

  it('같은 시드와 입력이면 행동과 가중치가 완전히 같다', () => {
    const inputs = situations(300);
    const a = PetBrain.create(graph, 42);
    const b = PetBrain.create(graph, 42);
    expect(decideAll(b, inputs, true)).toEqual(decideAll(a, inputs, true));
    expect(b.encode()).toEqual(a.encode());
    expect(a.updates).toBeGreaterThan(0);
    // Another pet makes other choices.
    expect(decideAll(PetBrain.create(graph, 43), inputs, true)).not.toEqual(decideAll(PetBrain.create(graph, 42), inputs, true));
  });

  it('학습을 끄면 판독 가중치와 학습 횟수가 그대로다', () => {
    const brain = PetBrain.create(graph, 8);
    decideAll(brain, situations(50, 1), true);
    const before = readout(brain);
    const updates = brain.updates;
    decideAll(brain, situations(300, 2), false);
    expect(readout(brain)).toEqual(before);
    expect(brain.updates).toBe(updates);
  });

  it('숙련도를 재도 상태가 바뀌지 않는다', () => {
    const brain = PetBrain.create(graph, 12);
    train(brain, { commands: ['sit'], maxTrials: 20, checkEvery: 1000, stopWhenLearned: false });
    const twin = PetBrain.decode(graph, 12, brain.encode());
    brain.resetActivity();
    for (const command of COMMANDS) expect(brain.mastery(command)).toBe(twin.mastery(command));
    expect(brain.encode()).toEqual(twin.encode());
    const inputs = situations(60, 3);
    expect(decideAll(brain, inputs, true)).toEqual(decideAll(twin, inputs, true));
  });

  it('회로 연결을 지운 대조군과 활동이 다르고 행동도 달라진다', () => {
    const inputs = situations(48, 4);
    let differences = 0;
    let l1 = 0;
    let comparisons = 0;
    for (const seed of [101, 102, 103, 104]) {
      // Same seed and the same trained readout; only the circuit's connections differ.
      const real = PetBrain.create(graph, seed);
      train(real, { commands: ['sit', 'down', 'come'], maxTrials: 40, checkEvery: 1000, stopWhenLearned: false });
      const saved = real.encode();
      const withCircuit = PetBrain.decode(graph, seed, saved);
      const without = PetBrain.decode(noConnections, seed, saved);
      for (const input of inputs) {
        const values = sense(input);
        const legal = legalActions(values);
        withCircuit.decide(values, { learning: false, legal, current: null });
        without.decide(values, { learning: false, legal, current: null });
        const a = withCircuit.readActivity();
        const b = without.readActivity();
        l1 += a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0) / a.length;
        comparisons++;
      }
      for (const command of [...COMMANDS, null]) {
        for (const context of probeContexts(command, 50)) {
          const values = sense(context);
          const legal = legalActions(values);
          if (withCircuit.greedy(values, legal) !== without.greedy(values, legal)) differences++;
        }
      }
    }
    expect(l1 / comparisons).toBeGreaterThan(1e-3);
    expect(differences).toBeGreaterThanOrEqual(1);
  });

  it('1초 늦게 준 간식도 방금 한 행동의 값을 올리고, 꾸중은 내린다', () => {
    const input: SenseInput = { ...probeContexts('sit', 18)[0]!, command: 'sit' };
    const values = sense(input);
    const only = (action: PetAction) => ACTIONS.map((name) => name === action);
    const delayed = (amount: number) => {
      const brain = PetBrain.create(graph, 31);
      const before = brain.evaluate(values)[ACTION.sit]!;
      brain.startTrial();
      expect(brain.decide(values, { learning: true, legal: only('sit'), current: null }).action).toBe('sit');
      // Two more decisions (one second) standing before the reward arrives.
      brain.decide(values, { learning: true, legal: only('stand'), current: null });
      brain.decide(values, { learning: true, legal: only('stand'), current: null });
      brain.reward(amount, true);
      brain.decide(values, { learning: true, legal: only('stand'), current: null });
      return brain.evaluate(values)[ACTION.sit]! - before;
    };
    const nothing = delayed(0);
    expect(delayed(1) - nothing).toBeGreaterThan(0.03);
    expect(delayed(-0.6) - nothing).toBeLessThan(-0.02);
  });

  it('새 명령은 앞선 시도의 흔적을 지운다', () => {
    const input: SenseInput = { ...probeContexts('sit', 18)[0]!, command: 'sit' };
    const values = sense(input);
    const only = (action: PetAction) => ACTIONS.map((name) => name === action);
    const brain = PetBrain.create(graph, 32);
    const before = brain.evaluate(values)[ACTION.jump]!;
    brain.decide(values, { learning: true, legal: only('jump'), current: null });
    brain.startTrial();
    brain.decide(values, { learning: true, legal: only('sit'), current: null });
    brain.reward(1, true);
    brain.decide(values, { learning: true, legal: only('stand'), current: null });
    expect(brain.evaluate(values)[ACTION.jump]).toBeCloseTo(before, 6);
  });

  it('잘못된 입력은 받지 않는다', () => {
    const brain = PetBrain.create(graph, 1);
    const values = sense(situations(1)[0]!);
    const legal = legalActions(values);
    expect(() => PetBrain.create(graph, -1)).toThrow(RangeError);
    expect(() => PetBrain.create(graph, 2 ** 32)).toThrow(RangeError);
    expect(() => PetBrain.create(graph, 1.5)).toThrow(RangeError);
    expect(() => brain.decide(new Float32Array(19), { learning: false, legal, current: null })).toThrow(RangeError);
    const nan = values.slice();
    nan[3] = Number.NaN;
    expect(() => brain.decide(nan, { learning: false, legal, current: null })).toThrow(RangeError);
    expect(() => brain.decide(values, { learning: false, legal: legal.slice(1), current: null })).toThrow(RangeError);
    expect(() => brain.decide(values, { learning: false, legal: new Array(ACTION_COUNT).fill(false), current: null })).toThrow(RangeError);
    expect(() => brain.reward(Number.NaN)).toThrow(RangeError);
  });

  it('성향은 시드마다 0.8–1.2 안에서 다르다', () => {
    const temperaments = [1, 2, 3, 4, 5, 6].map((seed) => PetBrain.create(graph, seed).temperament);
    for (const temperament of temperaments) {
      for (const factor of Object.values(temperament)) {
        expect(factor).toBeGreaterThanOrEqual(0.8);
        expect(factor).toBeLessThanOrEqual(1.2);
      }
    }
    expect(new Set(temperaments.map((temperament) => temperament.sociability)).size).toBe(6);
  });

  it('공을 물고 있을 때는 가져오기를 계속할 수 있다', () => {
    const values = sense({ ...situations(1)[0]!, ballDistance: null, visitorDistance: null });
    expect(legalActions(values)[ACTION.fetch]).toBe(false);
    expect(legalActions(values)[ACTION.greet]).toBe(false);
    expect(legalActions(values, undefined, { carryingBall: true })[ACTION.fetch]).toBe(true);
  });
});

describe('펫 감각', () => {
  const base: SenseInput = {
    ownerDistance: 3,
    ownerBearing: Math.PI / 2,
    ownerSpeed: 2,
    command: 'down',
    ballDistance: 5,
    visitorDistance: 4,
    visitorNew: true,
    energy: 0.7,
    satiety: 0.4,
    sinceInteraction: 60,
    night: true,
  };

  it('20개 값을 정해진 식으로 쓴다', () => {
    const values = sense(base);
    expect(SENSES).toHaveLength(20);
    expect(values[SENSE.bias]).toBe(1);
    expect(values[SENSE.ownerNear]).toBeCloseTo(Math.exp(-1), 6);
    expect(values[SENSE.ownerFar]).toBeCloseTo(0.25, 6);
    expect(values[SENSE.ownerSin]).toBeCloseTo(1, 6);
    expect(values[SENSE.ownerCos]).toBeCloseTo(0, 6);
    expect(values[SENSE.ownerMoving]).toBeCloseTo(0.5, 6);
    expect([...values.subarray(SENSE.cueCome, SENSE.cueJump + 1)]).toEqual([0, 0, 1, 0, 0, 0, 0]);
    expect(cueOf(values)).toBe('down');
    expect(values[SENSE.ball]).toBeCloseTo(Math.exp(-1), 6);
    expect(values[SENSE.visitorNear]).toBeCloseTo(Math.exp(-1), 6);
    expect(values[SENSE.visitorNew]).toBe(1);
    expect(values[SENSE.energy]).toBeCloseTo(0.7, 6);
    expect(values[SENSE.satiety]).toBeCloseTo(0.4, 6);
    expect(values[SENSE.bored]).toBeCloseTo(0.5, 6);
    expect(values[SENSE.night]).toBe(1);
    const quiet = sense({ ...base, command: null, ballDistance: null, visitorDistance: null, ownerDistance: 30, sinceInteraction: 900, night: false });
    expect(cueOf(quiet)).toBeNull();
    expect([quiet[SENSE.ball], quiet[SENSE.visitorNear], quiet[SENSE.visitorNew], quiet[SENSE.night]]).toEqual([0, 0, 0, 0]);
    expect([quiet[SENSE.ownerFar], quiet[SENSE.bored]]).toEqual([1, 1]);
    expect(() => sense(base, new Float32Array(19))).toThrow(RangeError);
  });

  it('방향은 지금 바라보는 쪽에서 돌 각도이고, 밤은 22–6시다', () => {
    expect(bearing(0, 0, 0, 0, 5)).toBeCloseTo(0, 9);
    expect(bearing(0, 0, 0, 5, 0)).toBeCloseTo(Math.PI / 2, 9);
    expect(bearing(0, 0, Math.PI / 2, 5, 0)).toBeCloseTo(0, 9);
    expect(Math.abs(bearing(0, 0, 0, 0, -5))).toBeCloseTo(Math.PI, 9);
    expect(Math.abs(bearing(1, 1, 3 * Math.PI, 1, 2))).toBeCloseTo(Math.PI, 9);
    expect([22, 23, 0, 5].every(isNight)).toBe(true);
    expect([6, 12, 21].some(isNight)).toBe(false);
  });

  it('명령 없이 하는 재주는 조금 손해고, 지쳐서 쉬거나 심심해서 둘러보면 조금 이득이다', () => {
    const asked = sense({ ...base, command: 'sit' });
    const free = sense({ ...base, command: null });
    for (const trick of ['sit', 'down', 'speak', 'jump'] as const) {
      expect(intrinsicReward(trick, free)).toBe(-0.05);
      expect(intrinsicReward(trick, asked)).toBe(0);
    }
    expect(intrinsicReward('rest', sense({ ...base, energy: 0.2 }))).toBe(0.05);
    expect(intrinsicReward('rest', sense({ ...base, energy: 0.5 }))).toBe(0);
    expect(intrinsicReward('explore', sense({ ...base, sinceInteraction: 90 }))).toBe(0.02);
    expect(intrinsicReward('explore', sense({ ...base, sinceInteraction: 10 }))).toBe(0);
    expect(intrinsicReward('come', free)).toBe(0);
  });
});
