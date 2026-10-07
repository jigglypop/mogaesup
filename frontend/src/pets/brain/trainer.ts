import { applyFeedback, DEFAULT_DRIVES, driveActivity, stepDrives, treatAllowed, treatValue, type BondLedger, type PetDrives } from '../drives';
import type { PetBrain } from './brain';
import {
  COMMAND_SECONDS,
  DECISION_SECONDS,
  MASTERY_GOAL,
  PRAISE_REWARD,
  RESTED_ENERGY,
  TRAINER_FREE_SECONDS,
  TRAINER_REWARD_DELAY,
  TRAINER_STAY_SECONDS,
  UNCUED_LIMIT,
} from './constants';
import { intrinsicReward } from './innate';
import { EXPECTED, mastery, responseRates } from './probes';
import { Random, deriveSeed } from './random';
import { ACTION, ACTION_COUNT, SENSE_COUNT, TRICKS, legalActions, sense, type PetAction, type PetCommand } from './senses';

/**
 * A scripted owner for the learning tests and the headless report (`PETS_REPORT=1`). It gives a command, rewards the
 * right response a second later (a treat, or praise once treats are off or worth less), ends the trial with nothing
 * when the pet does a wrong trick (for stay: anything but standing, sitting or lying where it is while the owner walks
 * away), lets a command lapse when the pet does neither, and leaves three seconds of free time between trials. The
 * pet's body is a sketch: coming closes the distance at walking speed, exploring and going home take a few decisions,
 * postures last until the brain changes its mind.
 */
export type TrainingOptions = {
  commands: readonly PetCommand[];
  maxTrials: number;
  /** Probe contexts per criterion check. */
  probes?: number;
  /** Trials between criterion checks. */
  checkEvery?: number;
  /** The owner's own randomness (positions, command order); defaults to the pet's seed. */
  seed?: number;
  /** Stop once every command meets the criterion at a check. */
  stopWhenLearned?: boolean;
  /** false: right responses get nothing either (extinction). */
  rewardRight?: boolean;
  /** Starting drives (defaults: a new pet's). */
  drives?: PetDrives;
};

export type CommandProgress = {
  command: PetCommand;
  /** Trials of this command. */
  trials: number;
  /** Of those, how many were answered with a treat or praise. */
  rewarded: number;
  /** Total trials done when the command first met the criterion at a check, or null. */
  learnedAt: number | null;
  /** At the end: share of probes obeyed, and share of no-command probes in which the trick was done (tricks only). */
  mastery: number;
  uncued: number | null;
};

export type TrainingResult = {
  trials: number;
  treats: number;
  praises: number;
  decisions: number;
  /** Total trials done when every command met the criterion at the same check, or null. */
  learnedAt: number | null;
  commands: CommandProgress[];
  drives: PetDrives;
};

export type Criterion = { met: boolean; mastery: number; uncued: number | null };

const isTrick = (command: PetCommand): command is PetCommand & PetAction => TRICKS.includes(command as PetAction);

/** Learned: obeyed in at least MASTERY_GOAL of the probes and, for a trick, done unasked in at most UNCUED_LIMIT. */
export function criterion(brain: PetBrain, command: PetCommand, probes: number, uncuedRates?: Float64Array): Criterion {
  const obeyed = mastery(brain, command, probes);
  const uncued = isTrick(command) ? (uncuedRates ?? responseRates(brain, null, probes))[ACTION[command]]! : null;
  return { met: obeyed >= MASTERY_GOAL && (uncued === null || uncued <= UNCUED_LIMIT), mastery: obeyed, uncued };
}

const STEPS_PER_SECOND = 1 / DECISION_SECONDS;
const REWARD_DELAY = Math.round(TRAINER_REWARD_DELAY * STEPS_PER_SECOND);
const FREE_STEPS = Math.round(TRAINER_FREE_SECONDS * STEPS_PER_SECOND);
const STAY_STEPS = Math.round(TRAINER_STAY_SECONDS * STEPS_PER_SECOND);
const WALK_PER_STEP = 3 * DECISION_SECONDS;
const ARRIVED = 1.3;
const STAYS: readonly PetAction[] = ['stand', 'sit', 'down'];
/** Decisions spent walking home before lying down, and while the bark (1 s) and jump (1.5 s) clips play. */
const BUSY: Partial<Record<PetAction, number>> = { rest: 2, speak: 2, jump: 3 };
const HOUR = 3600;
/** A fixed calendar start, so the bond's daily cap behaves the same in every run. */
const START_MS = Date.UTC(2026, 9, 7, 3);

export function train(brain: PetBrain, options: TrainingOptions): TrainingResult {
  const { commands, maxTrials } = options;
  const probes = options.probes ?? 50;
  const checkEvery = options.checkEvery ?? 1;
  const rewardRight = options.rewardRight ?? true;
  if (!commands.length || !(maxTrials >= 1)) throw new RangeError('Training needs commands and trials');
  const rng = new Random(deriveSeed(options.seed ?? brain.seed, 77));
  const senses = new Float32Array(SENSE_COUNT);
  const legal = new Array<boolean>(ACTION_COUNT);

  let drives: PetDrives = { ...(options.drives ?? DEFAULT_DRIVES) };
  let ledger: BondLedger = { day: 0, gained: 0 };
  const treatTimes: number[] = [];
  let clock = 0;
  let since = 0;
  let decisions = 0;
  let treats = 0;
  let praises = 0;
  // The owner, relative to the pet.
  let distance = 2;
  let bearing = 0;
  let ownerSpeed = 0;
  /** Meters to a thrown ball on the ground (fetch trials), or null. */
  let ball: number | null = null;
  // The pet's body: what it is carrying out and for how many more decisions (exploring, walking home).
  let current: PetAction | null = null;
  let busy = 0;

  const step = (command: PetCommand | null): PetAction => {
    sense(
      {
        ownerDistance: distance,
        ownerBearing: bearing,
        ownerSpeed,
        command,
        ballDistance: ball,
        visitorDistance: null,
        visitorNew: false,
        energy: drives.energy,
        satiety: drives.satiety,
        sinceInteraction: since,
        night: false,
      },
      senses,
    );
    legalActions(senses, legal);
    const { action } = brain.decide(senses, { learning: true, legal, current });
    brain.reward(intrinsicReward(action, senses));
    let moving = false;
    if (action !== current) busy = action === 'explore' ? 2 + rng.int(5) : (BUSY[action] ?? 0);
    switch (action) {
      case 'come':
        distance = Math.max(1.2, distance - WALK_PER_STEP);
        moving = true;
        current = distance <= ARRIVED ? null : 'come';
        break;
      case 'fetch':
        ball = ball === null ? null : Math.max(0, ball - 2 * WALK_PER_STEP);
        moving = true;
        current = 'fetch';
        break;
      case 'explore':
        distance = Math.min(12, Math.max(1, distance + rng.range(-1, 1)));
        moving = true;
        current = --busy > 0 ? 'explore' : null;
        break;
      case 'rest':
        moving = busy-- > 0;
        current = moving || drives.energy < RESTED_ENERGY ? 'rest' : null;
        break;
      case 'sit':
      case 'down':
        current = action;
        break;
      case 'speak':
      case 'jump':
        current = --busy > 0 ? action : null;
        break;
      default:
        current = null;
    }
    distance += ownerSpeed * DECISION_SECONDS;
    drives = stepDrives(drives, DECISION_SECONDS, driveActivity(action, moving));
    clock += DECISION_SECONDS;
    since += DECISION_SECONDS;
    decisions++;
    return action;
  };

  const rewardRightResponse = () => {
    if (!rewardRight) {
      brain.reward(0, true);
      return;
    }
    while (treatTimes.length && treatTimes[0]! <= clock - HOUR) treatTimes.shift();
    const treat = treatAllowed(drives.satiety, treatTimes.length) && treatValue(drives.satiety) >= PRAISE_REWARD;
    const feedback = applyFeedback(drives, treat ? 'treat' : 'praise', ledger, START_MS + clock * 1000);
    drives = feedback.drives;
    ledger = feedback.ledger;
    brain.reward(feedback.reward, feedback.terminal);
    if (treat) {
      treats++;
      treatTimes.push(clock);
    } else praises++;
  };

  const progress = new Map<PetCommand, CommandProgress>(
    commands.map((command) => [command, { command, trials: 0, rewarded: 0, learnedAt: null, mastery: 0, uncued: null }]),
  );
  let learnedAt: number | null = null;
  let order: PetCommand[] = [];
  let trials = 0;

  while (trials < maxTrials) {
    if (!order.length) {
      order = [...commands];
      for (let i = order.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
    }
    const command = order.pop()!;
    const record = progress.get(command)!;
    trials++;
    record.trials++;
    // Where the owner stands for this command.
    bearing = rng.range(-Math.PI, Math.PI);
    if (command === 'come') {
      distance = rng.range(6, 10);
      ownerSpeed = 0;
    } else if (command === 'stay') {
      distance = rng.range(1.5, 2.5);
      ownerSpeed = rng.range(1.5, 3);
    } else if (command === 'fetch') {
      distance = rng.range(1.5, 3);
      ownerSpeed = 0;
      ball = rng.range(3, 8);
    } else {
      distance = rng.range(1.5, 3);
      ownerSpeed = 0;
    }
    brain.startTrial();
    since = 0;
    const limit = Number.isFinite(COMMAND_SECONDS[command]) ? COMMAND_SECONDS[command] * STEPS_PER_SECOND : 60;
    let rewardAt = -1;
    let held = 0;
    for (let k = 0; ; k++) {
      if (k === rewardAt) {
        rewardRightResponse();
        record.rewarded++;
        since = 0;
        break;
      }
      if (rewardAt < 0 && k >= limit) break;
      const action = step(command);
      if (rewardAt >= 0) continue;
      if (command === 'stay') {
        if (!STAYS.includes(action)) {
          brain.reward(0, true);
          break;
        }
        if (++held >= STAY_STEPS) rewardAt = k + REWARD_DELAY;
      } else if (EXPECTED[command].includes(action)) {
        rewardAt = k + REWARD_DELAY;
      } else if (TRICKS.includes(action)) {
        brain.reward(0, true);
        break;
      }
    }
    // Free time near the owner; a thrown ball is picked up.
    ownerSpeed = 0;
    ball = null;
    if (distance > 4) distance = rng.range(1.5, 3);
    for (let k = 0; k < FREE_STEPS; k++) step(null);

    const last = trials >= maxTrials;
    if (trials % checkEvery === 0 || last) {
      const uncued = responseRates(brain, null, probes);
      let all = true;
      for (const entry of progress.values()) {
        const result = criterion(brain, entry.command, probes, uncued);
        entry.mastery = result.mastery;
        entry.uncued = result.uncued;
        if (result.met) entry.learnedAt ??= trials;
        else all = false;
      }
      if (all) learnedAt ??= trials;
      if (learnedAt !== null && (options.stopWhenLearned ?? true)) break;
    }
  }
  return { trials, treats, praises, decisions, learnedAt, commands: [...progress.values()], drives };
}
