import { WEIGHT_LIMIT } from './constants';

/**
 * `pet-brain-v1`: what the server keeps of a pet's brain, little-endian.
 *
 *   0  4      magic "MGPB"
 *   4  2      version 1
 *   6  2      senses S (20)
 *   8  2      actions A (10)
 *   10 2      features F (129: bias + one per neuron)
 *   12 4      FNV-1a 32 of the graph id (`graphHash`)
 *   16 4      choice RNG state
 *   20 4      learning updates so far
 *   24 4·A·F  readout W_out, f32, action-major
 *
 * 5,184 bytes for the pets' graph. The input projection and temperament are not stored: the pet's seed makes them
 * again. Activity and eligibility start at zero on every load.
 */
export const BRAIN_MAGIC = 'MGPB';
export const BRAIN_VERSION = 1;
export const BRAIN_HEADER_BYTES = 24;

export type BrainRecord = {
  senses: number;
  actions: number;
  features: number;
  graphHash: number;
  rng: number;
  updates: number;
  /** actions × features */
  readout: Float32Array;
};

export const brainBytes = (actions: number, features: number) => BRAIN_HEADER_BYTES + 4 * actions * features;

const MAGIC = [...BRAIN_MAGIC].map((char) => char.charCodeAt(0));

export function encodeBrainRecord(record: BrainRecord): Uint8Array {
  const { senses, actions, features, graphHash, rng, updates, readout } = record;
  if (readout.length !== actions * features) throw new RangeError('Readout shape');
  const bytes = new Uint8Array(brainBytes(actions, features));
  const view = new DataView(bytes.buffer);
  MAGIC.forEach((code, index) => view.setUint8(index, code));
  view.setUint16(4, BRAIN_VERSION, true);
  view.setUint16(6, senses, true);
  view.setUint16(8, actions, true);
  view.setUint16(10, features, true);
  view.setUint32(12, graphHash >>> 0, true);
  view.setUint32(16, rng >>> 0, true);
  view.setUint32(20, Math.min(updates, 0xffffffff) >>> 0, true);
  for (let i = 0; i < readout.length; i++) view.setFloat32(BRAIN_HEADER_BYTES + 4 * i, readout[i]!, true);
  return bytes;
}

/** Reads a saved brain; throws unless it is a `pet-brain-v1` brain of exactly this shape and graph with sane weights. */
export function decodeBrainRecord(
  bytes: Uint8Array,
  expected: { senses: number; actions: number; features: number; graphHash: number },
): BrainRecord {
  const length = brainBytes(expected.actions, expected.features);
  if (bytes.length !== length) throw new TypeError(`Pet brain: expected ${length} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (MAGIC.some((code, index) => view.getUint8(index) !== code) || view.getUint16(4, true) !== BRAIN_VERSION) {
    throw new TypeError('Pet brain: not pet-brain-v1');
  }
  const senses = view.getUint16(6, true);
  const actions = view.getUint16(8, true);
  const features = view.getUint16(10, true);
  if (senses !== expected.senses || actions !== expected.actions || features !== expected.features) {
    throw new TypeError('Pet brain: shape differs');
  }
  const graphHash = view.getUint32(12, true);
  if (graphHash !== expected.graphHash >>> 0) throw new TypeError('Pet brain: made on another circuit');
  const readout = new Float32Array(actions * features);
  for (let i = 0; i < readout.length; i++) {
    const weight = view.getFloat32(BRAIN_HEADER_BYTES + 4 * i, true);
    if (!Number.isFinite(weight) || Math.abs(weight) > WEIGHT_LIMIT) throw new TypeError('Pet brain: weight out of range');
    readout[i] = weight;
  }
  return { senses, actions, features, graphHash, rng: view.getUint32(16, true), updates: view.getUint32(20, true), readout };
}

/** Standard base64 (the API's `brain` field). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
