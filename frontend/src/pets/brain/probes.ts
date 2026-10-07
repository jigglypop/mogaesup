import type { PetBrain } from './brain';
import { PROBE_COUNT, PROBE_SEED } from './constants';
import { Random } from './random';
import { ACTION, ACTION_COUNT, legalActions, sense, type PetAction, type PetCommand, type SenseInput } from './senses';

/**
 * Mastery: how often a pet, from rest and without exploring or learning, does what a command asks in a fixed set of
 * contexts. The panel's percentages and the learning tests use these same functions. The first 18 contexts are a grid
 * (3 owner distances × 3 directions × 2 energies); the rest are drawn from a fixed seed and add visitors, night, a
 * moving owner and other drives.
 */
export const EXPECTED: Readonly<Record<PetCommand, readonly PetAction[]>> = {
  come: ['come'],
  sit: ['sit'],
  down: ['down'],
  stay: ['stand', 'sit', 'down'],
  fetch: ['fetch'],
  speak: ['speak'],
  jump: ['jump'],
};

type Setting = 'near' | 'far' | 'leaving';
/** come is asked from 6–10 m; stay while the owner walks away; the rest (and no command) near the owner. */
const settingOf = (command: PetCommand | null): Setting => (command === 'come' ? 'far' : command === 'stay' ? 'leaving' : 'near');
const DISTANCES: Record<Setting, { grid: readonly number[]; min: number; max: number }> = {
  near: { grid: [1.5, 3, 6], min: 1.2, max: 6 },
  far: { grid: [6, 8, 10], min: 6, max: 10 },
  leaving: { grid: [2, 4, 6], min: 2, max: 8 },
};
const GRID_BEARINGS = [0, (2 * Math.PI) / 3, (-2 * Math.PI) / 3];
const GRID_ENERGIES = [0.55, 0.9];
const LEAVING_SPEED = 2.5;
const GRID_SIZE = 18;

/** The probe contexts for `command` (null: none in force). Same setting, same contexts: only the cue differs. */
export function probeContexts(command: PetCommand | null, count: number = PROBE_COUNT): SenseInput[] {
  if (!Number.isInteger(count) || count < GRID_SIZE) throw new RangeError(`At least ${GRID_SIZE} probes`);
  const setting = settingOf(command);
  const { grid, min, max } = DISTANCES[setting];
  const leaving = setting === 'leaving';
  const contexts: SenseInput[] = [];
  for (const ownerDistance of grid) {
    for (const ownerBearing of GRID_BEARINGS) {
      for (const energy of GRID_ENERGIES) {
        contexts.push({
          ownerDistance,
          ownerBearing,
          ownerSpeed: leaving ? LEAVING_SPEED : 0,
          command,
          ballDistance: command === 'fetch' ? 3 : null,
          visitorDistance: null,
          visitorNew: false,
          energy,
          satiety: 0.5,
          sinceInteraction: 5,
          night: false,
        });
      }
    }
  }
  const rng = new Random(PROBE_SEED + (setting === 'near' ? 0 : setting === 'far' ? 1 : 2));
  while (contexts.length < count) {
    // Every draw is made for every setting and command, so the extra contexts line up across cues.
    const ownerDistance = rng.range(min, max);
    const ownerBearing = rng.range(-Math.PI, Math.PI);
    const moving = rng.next();
    const speed = rng.range(0, 2);
    const leavingSpeed = rng.range(1.5, 4);
    const energy = rng.range(0.4, 1);
    const satiety = rng.range(0.2, 0.9);
    const sinceInteraction = rng.range(0, 60);
    const night = rng.next() < 0.1;
    const visitor = rng.next() < 0.5;
    const visitorDistance = rng.range(2, 8);
    const visitorNew = rng.next() < 0.5;
    const ballDistance = rng.range(1, 10);
    contexts.push({
      ownerDistance,
      ownerBearing,
      ownerSpeed: leaving ? leavingSpeed : moving < 0.7 ? 0 : speed,
      command,
      ballDistance: command === 'fetch' ? ballDistance : null,
      visitorDistance: visitor ? visitorDistance : null,
      visitorNew: visitor && visitorNew,
      energy,
      satiety,
      sinceInteraction,
      night,
    });
  }
  return contexts;
}

type ProbeSet = { senses: Float32Array[]; legal: boolean[][] };
const probeSets = new Map<string, ProbeSet>();

function probeSet(command: PetCommand | null, count: number): ProbeSet {
  const key = `${command ?? '-'}:${count}`;
  let set = probeSets.get(key);
  if (!set) {
    const senses = probeContexts(command, count).map((context) => sense(context));
    set = { senses, legal: senses.map((values) => legalActions(values)) };
    probeSets.set(key, set);
  }
  return set;
}

/** Share of the probes in which each action is chosen (ACTIONS order), for `command` or none. */
export function responseRates(brain: PetBrain, command: PetCommand | null, count: number = PROBE_COUNT): Float64Array {
  const { senses, legal } = probeSet(command, count);
  const chosen = new Uint32Array(ACTION_COUNT);
  senses.forEach((values, index) => {
    chosen[ACTION[brain.greedy(values, legal[index]!)]]!++;
  });
  return Float64Array.from(chosen, (times) => times / senses.length);
}

/** 0..1: share of the probes in which the pet does what `command` asks. */
export function mastery(brain: PetBrain, command: PetCommand, count: number = PROBE_COUNT): number {
  const { senses, legal } = probeSet(command, count);
  const expected = EXPECTED[command];
  let obeyed = 0;
  senses.forEach((values, index) => {
    if (expected.includes(brain.greedy(values, legal[index]!))) obeyed++;
  });
  return obeyed / senses.length;
}
