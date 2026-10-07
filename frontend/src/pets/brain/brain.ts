import { decodeBrainRecord, encodeBrainRecord } from './codec';
import {
  ACTIVITY_DECAY,
  ACTIVITY_GAIN,
  DISCOUNT,
  EPSILON_CUED,
  EPSILON_FREE,
  EPSILON_HELD,
  FEATURE_SCALE,
  INPUT_SPREAD,
  LEARNING_RATE,
  MICROSTEPS,
  READOUT_INIT,
  SWITCH_MARGIN,
  TD_ERROR_LIMIT,
  TRACE_DECAY,
  WEIGHT_LIMIT,
} from './constants';
import { graphHash, type PetGraph } from './graph';
import { innateValues, temperamentFor, type Temperament } from './innate';
import { mastery } from './probes';
import { Random, clamp, deriveSeed } from './random';
import { ACTION, ACTIONS, ACTION_COUNT, HELD_ACTIONS, OFFERS, SENSE_COUNT, cueOf, type PetAction, type PetCommand } from './senses';

/**
 * A pet's brain: the fixed fly circuit (`graph.ts`) driven by the pet's senses, read out into a value per action and
 * trained by the owner's rewards. Game design built on 초켓몬스터's connectome brain (`src/core/brain.ts`,
 * `src/game/connectome.ts`, same owner), rewritten on typed arrays:
 *
 * - Activity: a ← 0.35·a + 0.65·tanh(W_in·x + W_rec·a), four microsteps a decision. W_rec is the connectome's (fixed);
 *   W_in (neurons × 20) is uniform ±0.6 from the pet's seed and is not saved.
 * - Value: Q(a) = innate(a, x) + W_out[a]·φ with φ = [1, 0.35·a]; there is no sensory bypass, so everything learned
 *   is read from circuit activity. W_out (10 × 129) is the only learned state.
 * - Learning: at each decision, δ = clamp(r + (terminal ? 0 : γ·max Q(x_t)) − Q(x_{t−1}, a_{t−1}), ±4),
 *   W_out += η·δ·E / (1 + |φ_{t−1}|²) within ±12, then E ← γλ·E and E[a_t] += φ_t. Feedback ends a trial
 *   (terminal) and clears E; a new command clears E too and never bootstraps across.
 * - Choice: ε-greedy over the legal actions (ε 0.06 with no command in force; 0.3 with one, and then the pet offers
 *   answers rather than wandering off); a held posture, option or gesture only gives way to a value 0.15 higher, and
 *   exploration breaks it off at 0.06 only. While a command is in force only answers are held.
 *
 * Learning lives in the readout: the same rule learns about as fast with the circuit's connections removed
 * (`ablateGraph`, `__tests__/learning.test.ts`). The connections change the activity the readout reads, and with it
 * some of the pet's choices.
 */
export const BRAIN_MODEL = 'pet-brain-v1';

export type PetDecision = { action: PetAction; explored: boolean };
export type DecideOptions = {
  /** Learn from the reward since the last decision (only on the owner's page, while they are training). */
  learning: boolean;
  /** One per action (`legalActions`). */
  legal: readonly boolean[];
  /**
   * The action still being carried out, or null: a posture (sit, down, resting at home) until the brain picks something
   * else, an option on its way (come, fetch, greet, explore) until it arrives, a bark or jump while its clip plays.
   * Held actions (`HELD_ACTIONS`) resist switching; resting ends once energy is back (`RESTED_ENERGY`).
   */
  current: PetAction | null;
};

const INPUT_STREAM = 1;
const READOUT_STREAM = 2;
const CHOICE_STREAM = 4;
const HELD = ACTIONS.map((action) => HELD_ACTIONS.includes(action));
const OFFERED = ACTIONS.map((action) => OFFERS.includes(action));
// Read once: inside the hot loops an imported binding is a live lookup (and a getter under the test runner).
const S = SENSE_COUNT;
const A = ACTION_COUNT;
const DECAY = ACTIVITY_DECAY;
const GAIN = ACTIVITY_GAIN;
const STEPS = MICROSTEPS;
const SCALE = FEATURE_SCALE;
const LIMIT = WEIGHT_LIMIT;

export class PetBrain {
  readonly seed: number;
  readonly graph: PetGraph;
  readonly temperament: Readonly<Temperament>;
  /** Readout features: the bias and one per neuron. */
  readonly features: number;

  private readonly inputWeights: Float32Array;
  private readonly readout: Float32Array;
  private readonly trace: Float32Array;
  private activity: Float32Array;
  private spare: Float32Array;
  private readonly drive: Float32Array;
  private readonly phi: Float32Array;
  private readonly values = new Float64Array(ACTION_COUNT);
  // Probes run from rest on buffers of their own, so they never touch the live state.
  private readonly probeActivity: Float32Array;
  private readonly probeSpare: Float32Array;
  private readonly probePhi: Float32Array;
  private readonly probeValues = new Float64Array(ACTION_COUNT);
  private readonly rng: Random;
  private updateCount = 0;
  private pendingReward = 0;
  private pendingTerminal = false;
  private hasPending = false;
  private trialStarted = false;
  private hasPrevious = false;
  private previousValue = 0;
  private previousNorm = 0;
  private traceLive = false;

  private constructor(graph: PetGraph, seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Pet seed must be a u32');
    if (!(graph.size >= 1) || graph.offsets.length !== graph.size + 1) throw new TypeError('Pet graph shape');
    this.seed = seed;
    this.graph = graph;
    this.temperament = Object.freeze(temperamentFor(seed));
    const neurons = graph.size;
    this.features = neurons + 1;
    this.inputWeights = new Float32Array(neurons * SENSE_COUNT);
    const inputs = new Random(deriveSeed(seed, INPUT_STREAM));
    for (let i = 0; i < this.inputWeights.length; i++) this.inputWeights[i] = (inputs.next() - 0.5) * 2 * INPUT_SPREAD;
    this.readout = new Float32Array(ACTION_COUNT * this.features);
    const readout = new Random(deriveSeed(seed, READOUT_STREAM));
    for (let i = 0; i < this.readout.length; i++) this.readout[i] = (readout.next() - 0.5) * 2 * READOUT_INIT;
    this.trace = new Float32Array(this.readout.length);
    this.activity = new Float32Array(neurons);
    this.spare = new Float32Array(neurons);
    this.drive = new Float32Array(neurons);
    this.phi = new Float32Array(this.features);
    this.probeActivity = new Float32Array(neurons);
    this.probeSpare = new Float32Array(neurons);
    this.probePhi = new Float32Array(this.features);
    this.rng = new Random(deriveSeed(seed, CHOICE_STREAM));
  }

  /** A new pet: input projection and temperament from the seed, readout near zero. */
  static create(graph: PetGraph, seed: number): PetBrain {
    return new PetBrain(graph, seed);
  }

  /** A saved pet (`encode`); throws if the bytes are not a `pet-brain-v1` brain of this graph and shape. */
  static decode(graph: PetGraph, seed: number, bytes: Uint8Array): PetBrain {
    const brain = new PetBrain(graph, seed);
    const record = decodeBrainRecord(bytes, {
      senses: SENSE_COUNT,
      actions: ACTION_COUNT,
      features: brain.features,
      graphHash: graphHash(graph.id),
    });
    brain.readout.set(record.readout);
    brain.rng.state = record.rng;
    brain.updateCount = record.updates;
    return brain;
  }

  /** 5,184 bytes for the pets' graph (`codec.ts`). */
  encode(): Uint8Array {
    return encodeBrainRecord({
      senses: SENSE_COUNT,
      actions: ACTION_COUNT,
      features: this.features,
      graphHash: graphHash(this.graph.id),
      rng: this.rng.state,
      updates: this.updateCount,
      readout: this.readout,
    });
  }

  /** Learning updates applied so far. */
  get updates(): number {
    return this.updateCount;
  }

  /**
   * Four microsteps on `senses`; learns from the reward given since the last call when `learning`; picks an action.
   * `explored` is set when exploration replaced the best action.
   */
  decide(senses: Float32Array, o: DecideOptions): PetDecision {
    checkSenses(senses);
    const { legal } = o;
    if (legal.length !== ACTION_COUNT || !legal.some(Boolean)) throw new RangeError('Pet decision needs a legal action');
    const final = this.run(senses, this.activity, this.spare, this.phi);
    if (final !== this.activity) {
      this.spare = this.activity;
      this.activity = final;
    }
    const values = this.values;
    this.value(senses, this.phi, values);

    const boundary = this.trialStarted;
    if (o.learning && this.hasPrevious && (this.hasPending || !boundary)) {
      // A new command never bootstraps from what came before it: what is pending closes the old trial.
      const terminal = this.pendingTerminal || boundary;
      const target = this.pendingReward + (terminal ? 0 : DISCOUNT * bestValue(values, legal));
      this.learn(clamp(target - this.previousValue, -TD_ERROR_LIMIT, TD_ERROR_LIMIT));
      if (terminal) this.endTrace();
      this.value(senses, this.phi, values);
    }
    if (boundary || !o.learning) this.endTrace();
    this.pendingReward = 0;
    this.pendingTerminal = false;
    this.hasPending = false;
    this.trialStarted = false;

    // While a command is in force only an answer is held: resting, exploring or greeting give way to it at once.
    const cued = cueOf(senses) !== null;
    const current = o.current === null || boundary ? -1 : ACTION[o.current];
    const holds = current >= 0 && HELD[current] === true && legal[current] === true && (!cued || OFFERED[current] === true);
    const held = holds ? current : -1;
    let action = choose(values, legal, held);
    let explored = false;
    const epsilon = held >= 0 ? EPSILON_HELD : cued ? EPSILON_CUED : EPSILON_FREE;
    if (this.rng.next() < epsilon) {
      const pick = this.randomLegal(legal, cued);
      explored = pick !== action;
      action = pick;
    }

    if (o.learning) {
      const trace = this.trace;
      const features = this.features;
      if (this.traceLive) {
        const decay = DISCOUNT * TRACE_DECAY;
        for (let k = 0; k < trace.length; k++) trace[k]! *= decay;
      }
      let norm = 0;
      for (let k = 0, at = action * features; k < features; k++, at++) {
        const feature = this.phi[k]!;
        trace[at]! += feature;
        norm += feature * feature;
      }
      this.traceLive = true;
      this.hasPrevious = true;
      this.previousValue = values[action]!;
      this.previousNorm = norm;
    }
    return { action: ACTIONS[action]!, explored };
  }

  /** Adds to the reward the next `decide` learns from; `terminal` ends the trial there (owner feedback). */
  reward(amount: number, terminal = false): void {
    if (!Number.isFinite(amount)) throw new RangeError('Pet reward must be finite');
    if (amount === 0 && !terminal) return;
    this.pendingReward += amount;
    this.pendingTerminal ||= terminal;
    this.hasPending = true;
  }

  /** A new command: the next decision starts a fresh trial (eligibility cleared, held actions released). */
  startTrial(): void {
    this.trialStarted = true;
  }

  /** Share of the fixed probe contexts (`probes.ts`) in which the pet, from rest and without exploring, obeys `command`. */
  mastery(command: PetCommand): number {
    return mastery(this, command);
  }

  /** Back to rest: activity, eligibility and pending reward cleared (as on load). */
  resetActivity(): void {
    this.activity.fill(0);
    this.spare.fill(0);
    this.endTrace();
    this.pendingReward = 0;
    this.pendingTerminal = false;
    this.hasPending = false;
    this.trialStarted = false;
  }

  /** The best legal action for `senses` from rest (zero activity, four microsteps); changes nothing. */
  greedy(senses: Float32Array, legal: readonly boolean[]): PetAction {
    return ACTIONS[choose(this.evaluate(senses, this.probeValues), legal, -1)]!;
  }

  /** Each action's value for `senses` from rest; changes nothing. */
  evaluate(senses: Float32Array, out: Float64Array = new Float64Array(ACTION_COUNT)): Float64Array {
    checkSenses(senses);
    this.run(senses, this.probeActivity, this.probeSpare, this.probePhi, true);
    this.value(senses, this.probePhi, out);
    return out;
  }

  /** A copy of the current activity (tests, reports). */
  readActivity(out: Float32Array = new Float32Array(this.graph.size)): Float32Array {
    out.set(this.activity);
    return out;
  }

  /**
   * Runs the microsteps from `a` (or from rest: `a` is then ignored) and writes φ; `a` and `b` are overwritten and the
   * one holding the result is returned.
   */
  private run(senses: Float32Array, a: Float32Array, b: Float32Array, phi: Float32Array, fromRest = false): Float32Array {
    const neurons = this.graph.size;
    const inputs = this.inputWeights;
    const drive = this.drive;
    for (let i = 0, row = 0; i < neurons; i++, row += S) {
      let sum = 0;
      for (let j = 0; j < S; j++) sum += inputs[row + j]! * senses[j]!;
      drive[i] = sum;
    }
    const { offsets, sources, weights } = this.graph;
    let step = 0;
    if (fromRest) {
      // From zero activity the first microstep has no recurrent input.
      for (let i = 0; i < neurons; i++) b[i] = GAIN * Math.tanh(drive[i]!);
      const swap = a;
      a = b;
      b = swap;
      step = 1;
    }
    for (; step < STEPS; step++) {
      for (let i = 0; i < neurons; i++) {
        let sum = drive[i]!;
        for (let k = offsets[i]!, end = offsets[i + 1]!; k < end; k++) sum += weights[k]! * a[sources[k]!]!;
        b[i] = DECAY * a[i]! + GAIN * Math.tanh(sum);
      }
      const swap = a;
      a = b;
      b = swap;
    }
    phi[0] = 1;
    for (let i = 0; i < neurons; i++) phi[i + 1] = SCALE * a[i]!;
    return a;
  }

  private value(senses: Float32Array, phi: Float32Array, out: Float64Array): void {
    innateValues(senses, this.temperament, out);
    const features = this.features;
    const readout = this.readout;
    for (let action = 0, row = 0; action < A; action++, row += features) {
      let sum = out[action]!;
      for (let k = 0; k < features; k++) sum += readout[row + k]! * phi[k]!;
      out[action] = sum;
    }
  }

  private learn(delta: number): void {
    this.updateCount++;
    if (delta === 0 || !this.traceLive) return;
    const step = (LEARNING_RATE * delta) / (1 + this.previousNorm);
    const readout = this.readout;
    const trace = this.trace;
    for (let k = 0; k < readout.length; k++) {
      const eligibility = trace[k]!;
      if (eligibility === 0) continue;
      const weight = readout[k]! + step * eligibility;
      readout[k] = weight > LIMIT ? LIMIT : weight < -LIMIT ? -LIMIT : weight;
    }
  }

  private endTrace(): void {
    if (this.traceLive) this.trace.fill(0);
    this.traceLive = false;
    this.hasPrevious = false;
  }

  /** A uniformly random legal action; while a command is in force, one of the offers (`OFFERS`) when any is legal. */
  private randomLegal(legal: readonly boolean[], offering: boolean): number {
    let count = 0;
    let offers = 0;
    for (let action = 0; action < A; action++) {
      if (!legal[action]) continue;
      count++;
      if (OFFERED[action]) offers++;
    }
    const onlyOffers = offering && offers > 0;
    let pick = this.rng.int(onlyOffers ? offers : count);
    for (let action = 0; action < A; action++) {
      if (legal[action] && (!onlyOffers || OFFERED[action]) && pick-- === 0) return action;
    }
    return 0;
  }
}

function checkSenses(senses: Float32Array): void {
  if (senses.length !== S) throw new RangeError('Pet senses need 20 values');
  for (let j = 0; j < S; j++) if (!Number.isFinite(senses[j]!)) throw new RangeError('Pet senses must be finite');
}

function bestValue(values: Float64Array, legal: readonly boolean[]): number {
  let best = Number.NEGATIVE_INFINITY;
  for (let action = 0; action < A; action++) if (legal[action] && values[action]! > best) best = values[action]!;
  return best;
}

/** The highest legal value (ties to the lower index); a held action stays unless another beats it by SWITCH_MARGIN. */
function choose(values: Float64Array, legal: readonly boolean[], held: number): number {
  let best = -1;
  for (let action = 0; action < A; action++) {
    if (legal[action] && (best < 0 || values[action]! > values[best]!)) best = action;
  }
  if (held >= 0 && best !== held && values[best]! < values[held]! + SWITCH_MARGIN) return held;
  return best;
}
