import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BRAIN_MODEL, PetBrain } from '../brain/brain';
import { BRAIN_HEADER_BYTES, base64ToBytes, bytesToBase64, decodeBrainRecord } from '../brain/codec';
import { graphHash, parsePetGraph, type PetGraph } from '../brain/graph';
import { probeContexts } from '../brain/probes';
import { ACTION_COUNT, legalActions, sense } from '../brain/senses';
import { train } from '../brain/trainer';

const graph = parsePetGraph(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../brain/malecns-dna02-128.json'), 'utf8')));
const contexts = [...probeContexts('sit', 24), ...probeContexts(null, 24), ...probeContexts('come', 24)].map((context) => sense(context));

/** A pet with a few minutes of training behind it, so the readout is far from its starting values. */
function trained(seed: number): PetBrain {
  const brain = PetBrain.create(graph, seed);
  train(brain, { commands: ['sit', 'come'], maxTrials: 30, checkEvery: 1000, stopWhenLearned: false });
  return brain;
}

const header = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

describe('pet-brain-v1 형식', () => {
  it('5,184바이트에 머리말과 판독 가중치만 담는다', () => {
    const brain = trained(7);
    const bytes = brain.encode();
    expect(BRAIN_MODEL).toBe('pet-brain-v1');
    expect(bytes).toHaveLength(5184);
    expect(bytesToBase64(bytes)).toHaveLength(6912);
    const view = header(bytes);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('MGPB');
    expect(view.getUint16(4, true)).toBe(1);
    expect([view.getUint16(6, true), view.getUint16(8, true), view.getUint16(10, true)]).toEqual([20, 10, 129]);
    expect(view.getUint32(12, true)).toBe(graphHash(graph.id));
    expect(view.getUint32(20, true)).toBe(brain.updates);
    expect(brain.updates).toBeGreaterThan(0);
    expect(BRAIN_HEADER_BYTES + 4 * 10 * 129).toBe(5184);
  });

  it('다시 읽으면 Q값, 난수 상태, 학습 횟수가 같고 이어서 같은 결정을 한다', () => {
    const brain = trained(11);
    const copy = PetBrain.decode(graph, 11, base64ToBytes(bytesToBase64(brain.encode())));
    expect(copy.updates).toBe(brain.updates);
    expect(copy.encode()).toEqual(brain.encode());
    for (const values of contexts) expect(copy.evaluate(values)).toEqual(brain.evaluate(values));
    brain.resetActivity();
    const sequence = contexts.map((values) => {
      const legal = legalActions(values);
      return [brain.decide(values, { learning: true, legal, current: null }), copy.decide(values, { learning: true, legal, current: null })];
    });
    for (const [original, restored] of sequence) expect(restored).toEqual(original);
    expect(copy.encode()).toEqual(brain.encode());
  });

  it('입력 투영과 성향은 저장하지 않고 시드로 다시 만든다', () => {
    const brain = trained(5);
    const sameSeed = PetBrain.decode(graph, 5, brain.encode());
    const otherSeed = PetBrain.decode(graph, 6, brain.encode());
    expect(sameSeed.temperament).toEqual(brain.temperament);
    expect(otherSeed.temperament).not.toEqual(brain.temperament);
    expect(otherSeed.evaluate(contexts[0]!)).not.toEqual(brain.evaluate(contexts[0]!));
  });

  it('형식, 모양, 회로, 값이 틀린 뇌는 거부한다', () => {
    const good = trained(3).encode();
    const changed = (edit: (bytes: Uint8Array, view: DataView) => void) => {
      const bytes = good.slice();
      edit(bytes, header(bytes));
      return () => PetBrain.decode(graph, 3, bytes);
    };
    expect(() => PetBrain.decode(graph, 3, good)).not.toThrow();
    expect(() => PetBrain.decode(graph, 3, good.subarray(0, 5183))).toThrow(/5184 bytes/);
    expect(() => PetBrain.decode(graph, 3, new Uint8Array(5185))).toThrow(/5184 bytes/);
    expect(changed((bytes) => (bytes[0] = 0x4e))).toThrow(/pet-brain-v1/);
    expect(changed((_, view) => view.setUint16(4, 2, true))).toThrow(/pet-brain-v1/);
    expect(changed((_, view) => view.setUint16(6, 21, true))).toThrow(/shape/);
    expect(changed((_, view) => view.setUint16(8, 9, true))).toThrow(/shape/);
    expect(changed((_, view) => view.setUint16(10, 128, true))).toThrow(/shape/);
    expect(changed((_, view) => view.setUint32(12, 0x12345678, true))).toThrow(/another circuit/);
    expect(changed((_, view) => view.setFloat32(BRAIN_HEADER_BYTES + 400, Number.NaN, true))).toThrow(/weight/);
    expect(changed((_, view) => view.setFloat32(BRAIN_HEADER_BYTES, Number.POSITIVE_INFINITY, true))).toThrow(/weight/);
    expect(changed((_, view) => view.setFloat32(BRAIN_HEADER_BYTES + 4 * 1289, 12.5, true))).toThrow(/weight/);
    expect(changed((_, view) => view.setFloat32(BRAIN_HEADER_BYTES + 4 * 1289, -12, true))).not.toThrow();
    const otherCircuit: PetGraph = { ...graph, id: 'malecns-v1.0-mushroom-body-256' };
    expect(() => PetBrain.decode(otherCircuit, 3, good)).toThrow(/another circuit/);
  });

  it('머리말을 직접 읽어도 같은 값이다', () => {
    const brain = trained(9);
    const record = decodeBrainRecord(brain.encode(), { senses: 20, actions: ACTION_COUNT, features: 129, graphHash: graphHash(graph.id) });
    expect(record.readout).toHaveLength(1290);
    expect(record.updates).toBe(brain.updates);
    expect(record.readout.every((weight) => Math.abs(weight) <= 12)).toBe(true);
  });
});
