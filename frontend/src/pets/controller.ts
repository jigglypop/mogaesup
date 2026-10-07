import type { NPCBrainDecision } from 'gaesup-world';

import type { MyPet, PetBreed, PetDrivesRecord, PetStatsRecord } from '../api/types';
import type { PetBrain } from './brain/brain';
import { bytesToBase64 } from './brain/codec';
import {
  COMMAND_REPEAT_SECONDS,
  COMMAND_SECONDS,
  LEARNING_IDLE_SECONDS,
  TREATS_PER_HOUR,
  VISITOR_NEW_RADIUS,
  VISITOR_NEW_SECONDS,
} from './brain/constants';
import { intrinsicReward } from './brain/innate';
import { ACTION_COUNT, COMMANDS, SENSE_COUNT, bearing, isNight, legalActions, sense, type PetCommand } from './brain/senses';
import { parseChatLine } from './commands';
import {
  applyFeedback,
  catchUpDrives,
  driveActivity,
  readDrives,
  stepDrives,
  treatAllowed,
  type BondLedger,
  type PetDrives,
  type PetFeedback,
} from './drives';
import { PetMotor, type BreedMotion, type PetActivity, type PetBody, type Surroundings, type Vec3 } from './motor';
import breedList from './breeds.json';

/**
 * One owner's pet on their own island page: its brain, drives and training records, what is asked of it now, and its
 * body. The engine's NPC system asks it for a decision twice a second (`decide`, through the brain adapter PetWorld
 * registers); every frame it moves the body on (`tick`); the panel and the chat give it commands and feedback. It
 * learns only while the owner trains it: the page on show, not decorating or away on a game, the session's save not
 * refused, and the owner's last command or feedback under two minutes ago.
 */

/** The NPC's instance id for pet `id`, and the brain adapter its owner's page registers. */
export const petNpcId = (id: string) => `pet:${id}`;
export const PET_POLICY = 'pet-connectome';
/** Island scale of every character (`MINIME_SCALE`); the pet's template height is its model's, this makes it island-sized. */
export const PET_SCALE = 1.5;

/** The island around the pet, as PetWorld reads it from the runtime and the live room. */
export type PetWorldView = {
  /** The owner's character: where, facing where, how fast. */
  owner: () => { position: Vec3; yaw: number; speed: number } | null;
  /** Everyone else in the island's live room. */
  visitors: () => Iterable<{ id: string; position: Vec3 }>;
  /** The island's hour, 0–23. */
  hour: () => number;
  ground: (x: number, z: number) => number;
  walkable: (x: number, z: number) => boolean;
};

/** What keeps the pet from learning (or from moving about) on this page now. */
export type PetConditions = {
  /** The page is hidden. */
  hidden: boolean;
  /** The owner is decorating: the pet stands at home. */
  decorating: boolean;
  /** The owner is away on a game's map: the pet waits where it is. */
  away: boolean;
  /** Another page saved over this one's revision: it learns nothing until reloaded. */
  conflict: boolean;
  /** Another of the owner's pages relays the pet. */
  busy: boolean;
};

export type PetStatus = {
  activity: PetActivity;
  /** The command in force. */
  command: PetCommand | null;
  /** Each 0..100, whole. */
  drives: { energy: number; satiety: number; mood: number; bond: number };
  /** Percent per command; null until measured. */
  mastery: Readonly<Record<PetCommand, number>> | null;
  canTreat: boolean;
  learning: boolean;
  /** Another of the owner's pages relays the pet; this one only shows it. */
  busy: boolean;
};

/** A breed as the island draws it: the server's (published) breed with the app's own measurements where it has them. */
export type BreedInfo = {
  id: string;
  label: string;
  emoji: string;
  modelUrl: string;
  thumbnailUrl: string | null;
  clips: readonly string[];
  /** Template height, meters. */
  height: number;
  /** m/s at which the in-place walk keeps its paws planted, at island scale. */
  strideSpeed: number;
  /** The same for the run (the walk's when the breed has no measure of its own). */
  runStrideSpeed?: number;
  motion: BreedMotion;
};

type LocalBreed = { slug: string; model: string; height_m: number; length_m: number; stride_mps: { walk: number; run: number }; clips: Record<string, number> };
const LOCAL = new Map((breedList as LocalBreed[]).map((breed) => [breed.model, breed]));
const DEFAULT_CLIPS = ['idle', 'walk', 'run', 'bark', 'jump', 'sit', 'lie', 'sit_hold', 'lie_hold'];

/** How the island draws `breed`: its server record, completed by breeds.json for the models the app ships. */
export function breedInfo(breed: PetBreed): BreedInfo {
  const local = LOCAL.get(breed.modelUrl) ?? (breedList as LocalBreed[]).find((entry) => entry.slug === breed.id);
  const height = breed.heightM > 0 ? breed.heightM : (local?.height_m ?? 0.55);
  const length = (local?.length_m ?? height) * PET_SCALE;
  const clips = breed.clips.length ? breed.clips : local ? Object.keys(local.clips) : DEFAULT_CLIPS;
  return {
    id: breed.id,
    label: breed.label,
    emoji: breed.emoji,
    modelUrl: breed.modelUrl,
    thumbnailUrl: breed.thumbnailUrl,
    clips,
    height,
    strideSpeed: (local?.stride_mps.walk ?? 0.045) * PET_SCALE,
    runStrideSpeed: (local?.stride_mps.run ?? local?.stride_mps.walk ?? 0.045) * PET_SCALE,
    motion: { clips: new Set(clips), mouth: { ahead: length * 0.48, up: height * PET_SCALE * 0.55 } },
  };
}

const COUNTED: Record<PetFeedback, 'treats' | 'praises' | 'pats' | 'scolds'> = { treat: 'treats', praise: 'praises', pat: 'pats', scold: 'scolds' };
/** Feedback this soon after a command ended (a fetch whose ball came back) still counts for it. */
const FEEDBACK_AFTER_SECONDS = 5;
const MASTERY_DELAY_MS = 5000;
const FIRST_MASTERY_MS = 1200;
/** Most seconds of drives one decision counts (after a hidden tab, say). */
const MAX_DECISION_GAP = 2;
const percent = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100);
const HOUR = 3600;

/** Whole counts as the server keeps them, from what was saved (anything else ignored). */
function readStats(value: PetStatsRecord | undefined): Required<Omit<PetStatsRecord, 'commands'>> & {
  commands: Record<PetCommand, { given: number; treats: number; praises: number; scolds: number; mastery: number }>;
} {
  const whole = (raw: unknown, max = 1_000_000) => (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? Math.min(raw, max) : 0);
  const saved = value ?? {};
  const commands = {} as Record<PetCommand, { given: number; treats: number; praises: number; scolds: number; mastery: number }>;
  for (const command of COMMANDS) {
    const entry = saved.commands?.[command] ?? {};
    commands[command] = {
      given: whole(entry.given),
      treats: whole(entry.treats),
      praises: whole(entry.praises),
      scolds: whole(entry.scolds),
      mastery: whole(entry.mastery, 100),
    };
  }
  return {
    treats: whole(saved.treats),
    praises: whole(saved.praises),
    pats: whole(saved.pats),
    scolds: whole(saved.scolds),
    bondDay: whole(saved.bondDay),
    bondGainedMilli: whole(saved.bondGainedMilli, 1000),
    commands,
  };
}

export type PetControllerOptions = {
  pet: MyPet;
  breed: BreedInfo;
  brain: PetBrain;
  /** Seconds on a steady clock (performance.now by default). */
  clock?: () => number;
  /** Milliseconds since the epoch (Date.now by default): the bond's day, drives caught up since the last save. */
  wallClock?: () => number;
  /** Runs `work` when the page is idle (requestIdleCallback where there is one). */
  idle?: (work: () => void) => void;
};

export type PetSaveBody = { brain: string; drives: Required<PetDrivesRecord>; stats: PetStatsRecord };

export class PetController {
  readonly pet: MyPet;
  readonly breed: BreedInfo;
  readonly brain: PetBrain;
  name: string;
  home: Vec3;
  private drives: PetDrives;
  private ledger: BondLedger;
  private stats: ReturnType<typeof readStats>;
  private active: { command: PetCommand; since: number; until: number } | null = null;
  private lastCommand: { command: PetCommand; ended: number } | null = null;
  private lastInteraction = Number.NEGATIVE_INFINITY;
  private lastDecision: number | null = null;
  private treatTimes: number[] = [];
  private nearVisitors = new Map<string, number>();
  private conditions: PetConditions = { hidden: false, decorating: false, away: false, conflict: false, busy: false };
  private held: 'decorating' | 'away' | null = null;
  private mastery: Record<PetCommand, number> | null = null;
  private masteryTimer: ReturnType<typeof setTimeout> | null = null;
  private body: PetBody | null = null;
  private world: PetWorldView | null = null;
  private motor: PetMotor | null = null;
  private readonly senses = new Float32Array(SENSE_COUNT);
  private readonly legal = new Array<boolean>(ACTION_COUNT).fill(true);
  private readonly listeners = new Set<() => void>();
  private snapshot: PetStatus;
  /** Counts changes worth saving that are not in the brain itself (feedback, commands, stats). */
  private recordChanges = 0;
  private saved: { updates: number; records: number; drives: PetDrives };
  private disposed = false;
  private readonly clock: () => number;
  private readonly wallClock: () => number;
  private readonly idle: (work: () => void) => void;

  constructor({ pet, breed, brain, clock, wallClock, idle }: PetControllerOptions) {
    this.pet = pet;
    this.breed = breed;
    this.brain = brain;
    this.name = pet.name;
    this.clock = clock ?? (() => performance.now() / 1000);
    this.wallClock = wallClock ?? Date.now;
    this.idle =
      idle ??
      ((work) => {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(() => work(), { timeout: 2000 });
        else setTimeout(work, 0);
      });
    this.home = [pet.home.x, 0, pet.home.z];
    const savedAt = Date.parse(pet.updatedAt);
    const away = Number.isFinite(savedAt) ? (this.wallClock() - savedAt) / 1000 : 0;
    this.drives = catchUpDrives(readDrives(pet.drives), away);
    this.stats = readStats(pet.stats);
    this.ledger = { day: this.stats.bondDay, gained: this.stats.bondGainedMilli / 1000 };
    const masteries = Object.fromEntries(COMMANDS.map((command) => [command, this.stats.commands[command].mastery])) as Record<PetCommand, number>;
    if (COMMANDS.some((command) => this.stats.commands[command].given > 0)) this.mastery = masteries;
    this.saved = { updates: brain.updates, records: 0, drives: { ...this.drives } };
    this.snapshot = this.build();
    this.scheduleMastery(FIRST_MASTERY_MS);
  }

  /** PetWorld binds the NPC and the island once they exist; returns the way to unbind. */
  attach(body: PetBody, world: PetWorldView): () => void {
    this.body = body;
    this.world = world;
    this.motor = new PetMotor(body, this.breed.motion, this.pet.seed, {
      reward: (amount) => this.brain.reward(amount),
      returned: () => this.endCommand('fetch'),
    });
    this.lastDecision = null;
    this.brain.resetActivity();
    return () => {
      if (this.body !== body) return;
      this.body = null;
      this.world = null;
      this.motor = null;
    };
  }

  /** The NPC's motor (PetWorld reads the ball and the relay frame from it). */
  get bodyMotor(): PetMotor | null {
    return this.motor;
  }

  // --- The engine's decisions -----------------------------------------------------------------------------------

  /** One decision: senses, the brain's choice (learning from what came since the last one), the body's actions. */
  decide(): NPCBrainDecision | undefined {
    const { body, world, motor } = this;
    if (!body || !world || !motor || this.disposed) return undefined;
    const now = this.clock();
    const dt = this.lastDecision === null ? 0 : Math.min(MAX_DECISION_GAP, Math.max(0, now - this.lastDecision));
    this.lastDecision = now;
    this.expire(now);
    const around = this.surroundings(world);
    const hold = this.conditions.decorating ? 'decorating' : this.conditions.away ? 'away' : null;
    if (hold) {
      if (this.held === hold) return undefined;
      this.held = hold;
      this.active = null;
      if (hold === 'decorating') {
        motor.clearBall();
        body.place([this.home[0], world.ground(this.home[0], this.home[2]), this.home[2]], 0);
      }
      this.notify();
      return { source: 'scripted', reason: hold, actions: motor.hold(hold === 'away' ? 'sit' : 'stand', around) };
    }
    this.held = null;
    const pose = body.pose();
    const owner = around.owner;
    const position = pose?.position ?? this.home;
    sense(
      {
        ownerDistance: owner ? Math.hypot(owner.position[0] - position[0], owner.position[2] - position[2]) : Number.POSITIVE_INFINITY,
        ownerBearing: owner && pose ? bearing(position[0], position[2], pose.yaw, owner.position[0], owner.position[2]) : 0,
        ownerSpeed: owner?.speed ?? 0,
        command: this.active?.command ?? null,
        ballDistance: motor.ballDistance(),
        visitorDistance: around.visitor ? Math.hypot(around.visitor.position[0] - position[0], around.visitor.position[2] - position[2]) : null,
        visitorNew: this.visitorNew(now, world, position),
        energy: this.drives.energy,
        satiety: this.drives.satiety,
        sinceInteraction: Number.isFinite(this.lastInteraction) ? now - this.lastInteraction : 1e6,
        night: around.night,
      },
      this.senses,
    );
    legalActions(this.senses, this.legal, { carryingBall: motor.carrying });
    const learning = this.learning(now);
    const { action } = this.brain.decide(this.senses, { learning, legal: this.legal, current: motor.current(this.drives.energy) });
    this.brain.reward(intrinsicReward(action, this.senses));
    this.drives = stepDrives(this.drives, dt, driveActivity(action, body.moving()));
    const actions = motor.plan(action, around);
    this.notify();
    return actions.length ? { source: 'scripted', reason: action, actions } : undefined;
  }

  /** Every frame: the body's gestures, holds, arrivals and the ball. */
  tick(dt: number): void {
    const { motor, world } = this;
    if (!motor || !world || this.disposed) return;
    motor.tick(dt, this.surroundings(world));
    const activity = motor.activity(isNight(world.hour()), this.drives.energy);
    if (activity !== this.snapshot.activity) this.notify();
  }

  // --- The owner --------------------------------------------------------------------------------------------------

  /** A command from the panel or the chat; false when it was the same one a moment ago (or the ball could not go). */
  command(command: PetCommand): boolean {
    const now = this.clock();
    if (this.active?.command === command && now - this.active.since < COMMAND_REPEAT_SECONDS) return false;
    if (command === 'fetch' && !this.motor?.ball && !this.pitch()) return false;
    this.start(command, now);
    return true;
  }

  /** 공 던지기: the owner throws the ball (again) and asks for it back. */
  throwBall(): boolean {
    const now = this.clock();
    if (this.active?.command === 'fetch' && now - this.active.since < COMMAND_REPEAT_SECONDS) return false;
    if (!this.pitch()) return false;
    this.start('fetch', now);
    return true;
  }

  /** Treat, praise, pat or "안돼": the reward for what the pet just did, and what it does to the drives. */
  feedback(kind: PetFeedback): boolean {
    const now = this.clock();
    if (kind === 'treat') {
      this.pruneTreats(now);
      if (!treatAllowed(this.drives.satiety, this.treatTimes.length)) return false;
      this.treatTimes.push(now);
    }
    const result = applyFeedback(this.drives, kind, this.ledger, this.wallClock());
    this.drives = result.drives;
    this.ledger = result.ledger;
    this.brain.reward(result.reward, result.terminal);
    const counted = COUNTED[kind];
    this.stats[counted] = Math.min(1_000_000, this.stats[counted] + 1);
    const answered = this.active?.command ?? (this.lastCommand && now - this.lastCommand.ended <= FEEDBACK_AFTER_SECONDS ? this.lastCommand.command : null);
    if (answered && counted !== 'pats') {
      const entry = this.stats.commands[answered];
      entry[counted] = Math.min(1_000_000, entry[counted] + 1);
    }
    if (result.terminal && this.active) this.endCommand(this.active.command);
    this.lastInteraction = now;
    this.recordChanges++;
    this.scheduleMastery(MASTERY_DELAY_MS);
    this.notify();
    return true;
  }

  /** An owner's chat line: a command, praise or "안돼" when it is one (with or without the pet's name). */
  chat(line: string): boolean {
    const intent = parseChatLine(line, this.name);
    if (!intent) return false;
    if (intent.kind === 'command') return this.command(intent.command);
    return this.feedback(intent.kind);
  }

  setConditions(changes: Partial<PetConditions>): void {
    const next = { ...this.conditions, ...changes };
    if ((Object.keys(next) as (keyof PetConditions)[]).every((key) => next[key] === this.conditions[key])) return;
    this.conditions = next;
    if (next.busy || next.conflict) this.active = null;
    this.notify();
  }

  rename(name: string): void {
    this.name = name;
  }

  moveHome(x: number, z: number): void {
    this.home = [x, 0, z];
  }

  // --- What the panel and the save read ------------------------------------------------------------------------

  status(): PetStatus {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether anything worth saving changed since the last save. */
  changed(): boolean {
    if (this.brain.updates !== this.saved.updates || this.recordChanges !== this.saved.records) return true;
    const before = this.saved.drives;
    return (['energy', 'satiety', 'mood', 'bond'] as const).some((key) => Math.abs(this.drives[key] - before[key]) >= 0.02);
  }

  /** What a save sends now, and the mark to pass to `markSaved` once it is stored. */
  saveBody(): { body: PetSaveBody; mark: { updates: number; records: number; drives: PetDrives } } {
    const fixed = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
    const drives = { energy: fixed(this.drives.energy), satiety: fixed(this.drives.satiety), mood: fixed(this.drives.mood), bond: fixed(this.drives.bond) };
    const stats: PetStatsRecord = {
      treats: this.stats.treats,
      praises: this.stats.praises,
      pats: this.stats.pats,
      scolds: this.stats.scolds,
      bondDay: Math.max(0, Math.floor(this.ledger.day)),
      bondGainedMilli: Math.min(1000, Math.max(0, Math.round(this.ledger.gained * 1000))),
      commands: Object.fromEntries(COMMANDS.map((command) => [command, { ...this.stats.commands[command] }])),
    };
    return {
      body: { brain: bytesToBase64(this.brain.encode()), drives, stats },
      mark: { updates: this.brain.updates, records: this.recordChanges, drives: { ...this.drives } },
    };
  }

  markSaved(mark: { updates: number; records: number; drives: PetDrives }): void {
    this.saved = mark;
  }

  dispose(): void {
    this.disposed = true;
    if (this.masteryTimer) clearTimeout(this.masteryTimer);
    this.listeners.clear();
  }

  // --- Inside -----------------------------------------------------------------------------------------------------

  private start(command: PetCommand, now: number): void {
    this.active = { command, since: now, until: now + COMMAND_SECONDS[command] };
    this.brain.startTrial();
    const entry = this.stats.commands[command];
    entry.given = Math.min(1_000_000, entry.given + 1);
    this.lastInteraction = now;
    this.recordChanges++;
    this.notify();
  }

  private pitch(): boolean {
    const { motor, world } = this;
    if (!motor || !world || this.conditions.decorating || this.conditions.away) return false;
    return motor.throwBall(this.surroundings(world));
  }

  private endCommand(command: PetCommand): void {
    if (this.active?.command !== command) return;
    this.lastCommand = { command, ended: this.clock() };
    this.active = null;
    this.notify();
  }

  private expire(now: number): void {
    if (!this.active) return;
    const fetchWithoutBall = this.active.command === 'fetch' && !this.motor?.ball;
    if (now >= this.active.until || fetchWithoutBall) this.endCommand(this.active.command);
  }

  private learning(now: number): boolean {
    const { hidden, decorating, away, conflict, busy } = this.conditions;
    return !hidden && !decorating && !away && !conflict && !busy && now - this.lastInteraction < LEARNING_IDLE_SECONDS;
  }

  private surroundings(world: PetWorldView): Surroundings {
    const pose = this.body?.pose();
    const at = pose?.position ?? this.home;
    let nearest: { id: string; position: Vec3 } | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const visitor of world.visitors()) {
      const distance = Math.hypot(visitor.position[0] - at[0], visitor.position[2] - at[2]);
      if (distance < best) {
        best = distance;
        nearest = visitor;
      }
    }
    return {
      owner: world.owner(),
      visitor: nearest,
      home: this.home,
      energy: this.drives.energy,
      night: isNight(world.hour()),
      ground: world.ground,
      walkable: world.walkable,
    };
  }

  /** A visitor came within VISITOR_NEW_RADIUS in the last VISITOR_NEW_SECONDS. */
  private visitorNew(now: number, world: PetWorldView, at: Vec3): boolean {
    const seen = new Set<string>();
    let fresh = false;
    for (const visitor of world.visitors()) {
      const near = Math.hypot(visitor.position[0] - at[0], visitor.position[2] - at[2]) <= VISITOR_NEW_RADIUS;
      if (!near) continue;
      seen.add(visitor.id);
      const since = this.nearVisitors.get(visitor.id);
      if (since === undefined) this.nearVisitors.set(visitor.id, now);
      if (now - (since ?? now) <= VISITOR_NEW_SECONDS) fresh = true;
    }
    for (const id of [...this.nearVisitors.keys()]) if (!seen.has(id)) this.nearVisitors.delete(id);
    return fresh;
  }

  private pruneTreats(now: number): void {
    while (this.treatTimes.length && this.treatTimes[0]! <= now - HOUR) this.treatTimes.shift();
  }

  private scheduleMastery(delayMs: number): void {
    if (this.masteryTimer || this.disposed) return;
    this.masteryTimer = setTimeout(() => {
      this.masteryTimer = null;
      this.idle(() => {
        if (this.disposed) return;
        // Read off the brain, so it goes with the next save the brain or the counts need, never one of its own.
        const next = {} as Record<PetCommand, number>;
        for (const command of COMMANDS) {
          next[command] = percent(this.brain.mastery(command));
          this.stats.commands[command].mastery = next[command];
        }
        this.mastery = next;
        this.notify();
      });
    }, delayMs);
  }

  private build(): PetStatus {
    const world = this.world;
    const night = world ? isNight(world.hour()) : false;
    const now = this.clock();
    this.pruneTreats(now);
    return {
      activity: this.motor?.activity(night, this.drives.energy) ?? 'stand',
      command: this.active?.command ?? null,
      drives: {
        energy: percent(this.drives.energy),
        satiety: percent(this.drives.satiety),
        mood: percent(this.drives.mood),
        bond: percent(this.drives.bond),
      },
      mastery: this.mastery,
      canTreat: treatAllowed(this.drives.satiety, this.treatTimes.length) && this.treatTimes.length < TREATS_PER_HOUR,
      learning: this.learning(now),
      busy: this.conditions.busy,
    };
  }

  /** Tells the panel when something it shows changed. */
  private notify(): void {
    const next = this.build();
    const before = this.snapshot;
    const same =
      next.activity === before.activity &&
      next.command === before.command &&
      next.mastery === before.mastery &&
      next.canTreat === before.canTreat &&
      next.learning === before.learning &&
      next.busy === before.busy &&
      next.drives.energy === before.drives.energy &&
      next.drives.satiety === before.drives.satiety &&
      next.drives.mood === before.drives.mood &&
      next.drives.bond === before.drives.bond;
    if (same) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
