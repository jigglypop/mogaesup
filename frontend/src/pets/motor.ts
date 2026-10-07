import type { NPCAction } from 'gaesup-world';

import { BALL_PICKUP_REWARD, GREET_REWARD, RESTED_ENERGY } from './brain/constants';
import { Random, deriveSeed } from './brain/random';
import type { PetAction } from './brain/senses';

/**
 * The pet's body: turns what its brain chose into the engine NPC's actions (`moveTo`, `idle` with a looping clip) and
 * one-shot gestures, keeps a posture until something else is chosen, runs fetching (ball → mouth → owner) and the ball
 * itself, and says what it is doing for the brain (`current`), the panel (`activity`) and the visitors' relay (`frame`).
 * The studio's dogs move in place, so the NPC's `strideSpeed` sets how fast the paws go; postures are held with the
 * looping `sit_hold`/`lie_hold` clips, which take over from the one-shot `sit`/`lie` once the dog is down.
 */
export type Vec3 = [number, number, number];

/** The engine NPC the motor drives (PetWorld binds it to the runtime's NPC store and simulation). */
export type PetBody = {
  /** Where it stands now and which way it faces (radians about Y, forward = (sin, cos)); null before it is placed. */
  pose(): { position: Vec3; yaw: number } | null;
  /** Whether it is walking a route now (as the drawn NPC sees it). */
  moving(): boolean;
  /** Applies NPC actions in one store update. */
  act(actions: NPCAction[]): void;
  /** Plays a one-shot clip once (the engine plays it only while the NPC stands). */
  gesture(clip: string): void;
  /** Turns it toward a point. */
  face(target: Vec3): void;
  /** Puts it at a point at once. */
  place(at: Vec3, yaw: number): void;
};

/** What the pet perceives of the island at a decision or frame. */
export type Surroundings = {
  owner: { position: Vec3; yaw: number; speed: number } | null;
  /** The nearest visitor, if any. */
  visitor: { id: string; position: Vec3 } | null;
  home: Vec3;
  energy: number;
  night: boolean;
  ground: (x: number, z: number) => number;
  walkable: (x: number, z: number) => boolean;
};

/** What the panel shows the pet doing. */
export type PetActivity =
  | 'stand'
  | 'come'
  | 'sit'
  | 'down'
  | 'speak'
  | 'jump'
  | 'fetchBall'
  | 'fetchBack'
  | 'explore'
  | 'greet'
  | 'rest'
  | 'sleep';

export const ACTIVITY_LABEL: Readonly<Record<PetActivity, string>> = {
  stand: '서 있음',
  come: '오는 중',
  sit: '앉아 있음',
  down: '엎드려 있음',
  speak: '짖는 중',
  jump: '점프',
  fetchBall: '공 가지러 감',
  fetchBack: '공 가져오는 중',
  explore: '둘러보는 중',
  greet: '손님 맞이',
  rest: '쉬는 중',
  sleep: '자는 중',
};

/** Clips that hold a posture (loop), and the one-shots that lead into them. */
export const POSTURE_CLIPS = { sit: { once: 'sit', hold: 'sit_hold', after: 1.0 }, down: { once: 'lie', hold: 'lie_hold', after: 1.1 } } as const;
/** The clips a relay frame may name (the server checks the same lists). */
export const FRAME_CLIPS = ['idle', 'walk', 'run', 'sit_hold', 'lie_hold', 'sit', 'lie'] as const;
export const FRAME_GESTURES = ['bark', 'jump', 'sit', 'lie'] as const;
export type FrameClip = (typeof FRAME_CLIPS)[number];
export type FrameGesture = (typeof FRAME_GESTURES)[number];

/** Seconds the one-shot clips last (the studio's: bark 1 s, jump 1.5 s). */
const TRICK_SECONDS = { bark: 1, jump: 1.5 } as const;
/** A gesture waits this long after the NPC stops, so the drawn model has stopped too (it skips gestures while moving). */
const GESTURE_SETTLE = 0.2;
/**
 * Coming stops this far from the owner (or a visitor), and counts as there within ARRIVED: beside a character drawn at
 * island scale (1.5×, about 0.5 m wide), not behind its legs.
 */
const NEAR_OWNER = 1.8;
const ARRIVED = 2.3;
/** Farther than this from the owner it comes by appearing behind them. */
const TELEPORT_METERS = 25;
const BEHIND_OWNER = 1.5;
/** m/s: walking, the most it runs to come, and the most it keeps up with a running owner at. */
const WALK_SPEED = 3;
const COME_SPEED = 7;
const FOLLOW_SPEED = 12;
const RUN_FROM = 3.8;
const EXPLORE_SPEED = 1.6;
const HOME_SPEED = 2.2;
const GREET_SPEED = 4;
const FETCH_SPEED = 6;
/** Within this the ball is picked up, and dropped this near the owner. */
const PICK_UP = 0.7;
const DROP_AT = 1.9;
/** Where it brings the ball: this far from the owner. */
const BRING_TO = 1.5;
/** A route is planned again when its goal moved this far. */
const RETARGET = 0.6;
const EXPLORE_RADIUS = 5;
/** Ball: radius, how far a throw lands, how long it flies and how high it goes above the straight line. */
export const BALL_RADIUS = 0.1;
const THROW_METERS = [7, 5.5, 4, 2.5];
const THROW_SECONDS = 0.9;
const THROW_ARC = 1.6;

const dist2d = (a: readonly number[], b: readonly number[]) => Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
const forward = (yaw: number): [number, number] => [Math.sin(yaw), Math.cos(yaw)];

export type BreedMotion = {
  /** Clips the model has; postures fall back to the one-shot `sit`/`lie` without the hold clips. */
  clips: ReadonlySet<string>;
  /** How far ahead of its root and how high its mouth is, in island meters (the held ball). */
  mouth: { ahead: number; up: number };
};

/** Where the ball is: flying from a throw, on the ground, or in the pet's mouth. */
export type Ball = {
  at: Vec3;
  held: boolean;
  /** The throw underway: from, to, and when (motor seconds) it left. */
  flight: { from: Vec3; to: Vec3; at: number } | null;
};

/**
 * Postures and gestures on one body, for the owner's motor and the visitors' puppet alike: `settle` stands the pet up
 * or has it sit or lie (the one-shot clip, then its hold), and gestures wait until the body has stopped.
 */
export class PetPose {
  /** The posture shown while it stands still. */
  posture: 'stand' | 'sit' | 'down' = 'stand';
  /** The clip the NPC loops while still (its `idleAnimation`). */
  idleClip = 'idle';
  /** The last gesture played, by motor time, for the relay. */
  lastGesture: { clip: FrameGesture; at: number } | null = null;
  private pending: { clip: string; notBefore: number } | null = null;
  private cut: { clip: string; at: number } | null = null;
  private stillSince = 0;
  private wasMoving = false;

  constructor(
    private readonly body: PetBody,
    private readonly motion: BreedMotion,
  ) {}

  has(clip: string): boolean {
    return this.motion.clips.has(clip);
  }

  /**
   * Stands it up or puts it in `posture`, stopping it where it is; `actions` gets what the NPC needs. A pose it already
   * holds, standing still, changes nothing.
   */
  settle(posture: 'stand' | 'sit' | 'down', now: number, actions: NPCAction[], { gesture = true }: { gesture?: boolean } = {}): void {
    const moving = this.body.moving();
    if (posture === this.posture && !moving) return;
    const from = this.posture;
    this.posture = posture;
    this.cut = null;
    if (this.pending?.clip === 'sit' || this.pending?.clip === 'lie') this.pending = null;
    if (posture === 'stand') {
      this.idle('idle', actions);
      return;
    }
    const clips = POSTURE_CLIPS[posture];
    const holds = this.has(clips.hold);
    this.idle(holds ? clips.hold : 'idle', actions);
    // From standing the one-shot leads down into the hold; from the other posture (sit ↔ lie) the hold blends over.
    if (gesture && this.has(clips.once) && (from === 'stand' || moving || !holds)) this.queue(clips.once, now);
  }

  /** A one-shot clip as soon as the body has stood still a moment. */
  queue(clip: string, now: number): void {
    this.pending = { clip, notBefore: now + GESTURE_SETTLE };
  }

  /** The NPC loops `clip` where it stands. */
  idle(clip: string, actions: NPCAction[]): void {
    this.idleClip = clip;
    actions.push({ type: 'idle', animationId: clip });
  }

  /** Before walking: the clip it loops on arrival is the standing one again. */
  beforeMove(actions: NPCAction[]): void {
    this.posture = 'stand';
    this.cut = null;
    if (this.pending && this.pending.clip !== 'bark' && this.pending.clip !== 'jump') this.pending = null;
    if (this.idleClip !== 'idle') this.idle('idle', actions);
  }

  /** Plays what waited for the body to stop, and switches a sit or lie to its hold once the dog is down. */
  tick(now: number): void {
    const moving = this.body.moving();
    if (moving !== this.wasMoving) {
      this.wasMoving = moving;
      if (!moving) this.stillSince = now;
    }
    if (this.pending && !moving && now >= this.pending.notBefore && now - this.stillSince >= GESTURE_SETTLE) {
      const { clip } = this.pending;
      this.pending = null;
      this.body.gesture(clip);
      if ((FRAME_GESTURES as readonly string[]).includes(clip)) this.lastGesture = { clip: clip as FrameGesture, at: now };
      const posture = clip === 'sit' ? POSTURE_CLIPS.sit : clip === 'lie' ? POSTURE_CLIPS.down : null;
      if (posture && this.has(posture.hold) && this.idleClip === posture.hold) this.cut = { clip: posture.hold, at: now + posture.after };
    }
    // The one-shot sit (down, hold, up) gives way to its hold in the middle, so the dog stays down.
    if (this.cut && now >= this.cut.at) {
      const { clip } = this.cut;
      this.cut = null;
      if (this.idleClip === clip && !moving) this.body.gesture(clip);
    }
  }

  /** The looping clip a relay frame names while it stands still. */
  stillClip(): FrameClip {
    if (this.posture === 'stand') return 'idle';
    const clips = POSTURE_CLIPS[this.posture];
    return this.has(clips.hold) ? clips.hold : clips.once;
  }

  /** Something waits to be played. */
  get busy(): boolean {
    return this.pending !== null;
  }
}

type Task =
  | { kind: 'come'; target: Vec3 | null }
  | { kind: 'fetch'; target: Vec3 | null }
  | { kind: 'explore'; target: Vec3 }
  | { kind: 'greet'; visitor: string; target: Vec3 | null }
  | { kind: 'rest'; target: Vec3 | null; arrived: boolean }
  | { kind: 'trick'; clip: 'bark' | 'jump'; until: number };

export type MotorEvents = {
  /** A reward from the world: reaching a visitor it went to greet, picking up the ball. */
  reward?: (amount: number) => void;
  /** The ball came back to the owner. */
  returned?: () => void;
};

/** The owner's pet: the brain's choice each decision (`plan`), and every frame what cannot wait for one (`tick`). */
export class PetMotor {
  readonly pose: PetPose;
  ball: Ball | null = null;
  private task: Task | null = null;
  private action: PetAction | null = null;
  private moveClip: 'walk' | 'run' = 'walk';
  private moveSpeed = 0;
  private walking = false;
  private now = 0;
  private readonly rng: Random;
  private lastFetchRetarget = 0;

  constructor(
    private readonly body: PetBody,
    private readonly motion: BreedMotion,
    seed: number,
    private readonly events: MotorEvents = {},
  ) {
    this.pose = new PetPose(body, motion);
    this.rng = new Random(deriveSeed(seed, 91));
  }

  get time(): number {
    return this.now;
  }

  /** Whether the ball is in the pet's mouth. */
  get carrying(): boolean {
    return !!this.ball?.held;
  }

  /** Meters from the pet to a ball lying on the ground, or null. */
  ballDistance(): number | null {
    const ball = this.ball;
    const pose = this.body.pose();
    if (!ball || ball.held || ball.flight || !pose) return null;
    return dist2d(pose.position, ball.at);
  }

  /** What the brain is still carrying out (`DecideOptions.current`). */
  current(energy: number): PetAction | null {
    const task = this.task;
    if (task) {
      switch (task.kind) {
        case 'trick':
          return task.until > this.now ? (task.clip === 'bark' ? 'speak' : 'jump') : null;
        case 'rest':
          return !task.arrived || energy < RESTED_ENERGY ? 'rest' : null;
        default:
          return task.kind;
      }
    }
    if (this.pose.posture === 'sit') return 'sit';
    if (this.pose.posture === 'down') return 'down';
    return null;
  }

  /** What the panel shows. */
  activity(night: boolean, energy: number): PetActivity {
    const task = this.task;
    switch (task?.kind) {
      case 'come':
        return 'come';
      case 'fetch':
        return this.carrying ? 'fetchBack' : 'fetchBall';
      case 'explore':
        return 'explore';
      case 'greet':
        return 'greet';
      case 'rest':
        return task.arrived && night && energy < 0.5 ? 'sleep' : 'rest';
      case 'trick':
        if (task.until > this.now) return task.clip === 'bark' ? 'speak' : 'jump';
        break;
    }
    return this.pose.posture === 'sit' ? 'sit' : this.pose.posture === 'down' ? 'down' : 'stand';
  }

  /** The engine actions for the brain's choice this decision. */
  plan(action: PetAction, world: Surroundings): NPCAction[] {
    const actions: NPCAction[] = [];
    const previous = this.action;
    this.action = action;
    if (action !== 'fetch' && this.ball?.held) this.dropBall(world);
    if (previous !== action && this.task && this.task.kind !== 'trick') this.task = null;
    switch (action) {
      case 'stand':
        this.task = null;
        this.stopAnd('stand', actions);
        break;
      case 'sit':
      case 'down':
        this.task = null;
        this.stopAnd(action, actions);
        break;
      case 'speak':
      case 'jump': {
        const clip = action === 'speak' ? 'bark' : 'jump';
        if (this.task?.kind === 'trick' && this.task.clip === clip && this.task.until > this.now) break;
        this.task = { kind: 'trick', clip, until: this.now + GESTURE_SETTLE * 2 + TRICK_SECONDS[clip] };
        this.stopAnd('stand', actions);
        if (this.pose.has(clip)) this.pose.queue(clip, this.now);
        break;
      }
      case 'come':
        this.come(world, actions);
        break;
      case 'fetch':
        this.fetch(world, actions);
        break;
      case 'explore':
        this.explore(world, actions);
        break;
      case 'greet':
        this.greet(world, actions);
        break;
      case 'rest':
        this.rest(world, actions);
        break;
    }
    return actions;
  }

  /** Every frame: gestures, a posture's hold, arrivals, the ball's flight, picking it up and bringing it back. */
  tick(dt: number, world: Surroundings): void {
    this.now += Math.max(0, Math.min(dt, 0.25));
    this.flyBall(world);
    this.pose.tick(this.now);
    const pose = this.body.pose();
    if (!pose) return;
    const moving = this.body.moving();
    const task = this.task;
    if (task?.kind === 'fetch') this.fetching(world, pose.position, moving);
    else if (this.walking && !moving && task) this.arrive(task, world, pose.position);
    if (!moving) this.walking = false;
    if (this.ball?.held) this.ball.at = this.mouth(pose);
  }

  /** The owner throws the ball from where they stand, ahead of them; it lands on open ground. */
  throwBall(world: Surroundings): boolean {
    const owner = world.owner;
    if (!owner) return false;
    const [fx, fz] = forward(owner.yaw);
    const [ox, , oz] = owner.position;
    const spread = (this.rng.next() - 0.5) * 0.5;
    const yaw = owner.yaw + spread;
    const [dx, dz] = forward(yaw);
    for (const meters of THROW_METERS) {
      const length = meters * (0.85 + this.rng.next() * 0.3);
      const x = ox + dx * length;
      const z = oz + dz * length;
      if (!world.walkable(x, z)) continue;
      const from: Vec3 = [ox + fx * 0.4, world.ground(ox, oz) + 1.2, oz + fz * 0.4];
      const to: Vec3 = [x, world.ground(x, z) + BALL_RADIUS, z];
      if (this.ball?.held && this.task?.kind === 'fetch') this.task = null;
      this.ball = { at: [...from], held: false, flight: { from, to, at: this.now } };
      return true;
    }
    return false;
  }

  /** Puts the ball away (the pet is put away, or the owner leaves). */
  clearBall(): void {
    this.ball = null;
    if (this.task?.kind === 'fetch') this.task = null;
  }

  /** The move clip and speed while walking, for the relay. */
  get movement(): { clip: 'walk' | 'run'; speed: number } {
    return { clip: this.moveClip, speed: this.moveSpeed };
  }

  /** Stops everything and stands still where it is (decorating, a game trip). */
  hold(posture: 'stand' | 'sit', world: Surroundings): NPCAction[] {
    const actions: NPCAction[] = [];
    this.task = null;
    this.action = null;
    if (this.ball?.held) this.dropBall(world);
    this.stopAnd(posture, actions);
    return actions;
  }

  // --- Tasks ---------------------------------------------------------------------------------------------------

  private stopAnd(posture: 'stand' | 'sit' | 'down', actions: NPCAction[]): void {
    this.walking = false;
    this.pose.settle(posture, this.now, actions);
  }

  private moveTo(target: Vec3, speed: number, actions: NPCAction[]): void {
    this.pose.beforeMove(actions);
    this.moveClip = speed >= RUN_FROM ? 'run' : 'walk';
    this.moveSpeed = speed;
    this.walking = true;
    actions.push({ type: 'moveTo', target, speed, animationId: this.moveClip });
  }

  /** Whether the route to `target` needs planning (again). */
  private stale(previous: Vec3 | null, target: Vec3, speed: number): boolean {
    return !previous || !this.walking || dist2d(previous, target) > RETARGET || Math.abs(speed - this.moveSpeed) > 0.75;
  }

  private come(world: Surroundings, actions: NPCAction[]): void {
    const owner = world.owner;
    const pose = this.body.pose();
    if (!owner || !pose) {
      this.task = null;
      this.stopAnd('stand', actions);
      return;
    }
    let at = pose.position;
    let distance = dist2d(at, owner.position);
    if (distance > TELEPORT_METERS) {
      at = this.behind(owner, world);
      this.body.place(at, owner.yaw);
      distance = dist2d(at, owner.position);
    }
    if (distance <= ARRIVED) {
      this.task = null;
      this.stopAnd('stand', actions);
      this.body.face(owner.position);
      return;
    }
    const target = this.near(owner.position, at, NEAR_OWNER, world);
    const speed = Math.min(FOLLOW_SPEED, Math.max(Math.min(COME_SPEED, Math.max(WALK_SPEED, distance * 0.8)), owner.speed * 1.1));
    const previous = this.task?.kind === 'come' ? this.task.target : null;
    this.task = { kind: 'come', target };
    if (this.stale(previous, target, speed)) this.moveTo(target, speed, actions);
  }

  private fetch(world: Surroundings, actions: NPCAction[]): void {
    const ball = this.ball;
    const pose = this.body.pose();
    if (!ball || !pose) {
      this.task = null;
      this.stopAnd('stand', actions);
      return;
    }
    const previous = this.task?.kind === 'fetch' ? this.task.target : null;
    const goal = this.fetchGoal(world, pose.position);
    this.task = { kind: 'fetch', target: goal };
    if (!goal) {
      this.stopAnd('stand', actions);
      return;
    }
    if (this.stale(previous, goal, FETCH_SPEED)) this.moveTo(goal, FETCH_SPEED, actions);
  }

  /** Where fetching heads now: the ball (where a throw will land), or with it in its mouth, the owner. */
  private fetchGoal(world: Surroundings, at: Vec3): Vec3 | null {
    const ball = this.ball;
    if (!ball) return null;
    if (!ball.held) return ball.flight ? [...ball.flight.to] : [...ball.at];
    return world.owner ? this.near(world.owner.position, at, BRING_TO, world) : null;
  }

  private fetching(world: Surroundings, at: Vec3, moving: boolean): void {
    const ball = this.ball;
    if (!ball) {
      this.task = null;
      return;
    }
    if (!ball.held) {
      if (ball.flight) return;
      const distance = dist2d(at, ball.at);
      // A route ends on the navigation grid, which may stop it a little short of the ball.
      if (distance <= PICK_UP || (!moving && distance <= PICK_UP * 2)) {
        ball.held = true;
        this.events.reward?.(BALL_PICKUP_REWARD);
        this.retargetFetch(world, at, true);
      } else if (!moving && this.now - this.lastFetchRetarget > 1) this.retargetFetch(world, at, true);
      return;
    }
    const owner = world.owner;
    if (owner && dist2d(at, owner.position) <= (moving ? DROP_AT : DROP_AT + 0.8)) {
      this.ball = null;
      this.task = null;
      const actions: NPCAction[] = [];
      this.stopAnd('stand', actions);
      if (actions.length) this.body.act(actions);
      this.body.face(owner.position);
      this.events.returned?.();
      return;
    }
    if (this.now - this.lastFetchRetarget > 0.5) this.retargetFetch(world, at, false);
  }

  private retargetFetch(world: Surroundings, at: Vec3, force: boolean): void {
    this.lastFetchRetarget = this.now;
    const goal = this.fetchGoal(world, at);
    if (!goal) return;
    const previous = this.task?.kind === 'fetch' ? this.task.target : null;
    if (!force && !this.stale(previous, goal, FETCH_SPEED)) return;
    this.task = { kind: 'fetch', target: goal };
    const actions: NPCAction[] = [];
    this.moveTo(goal, FETCH_SPEED, actions);
    this.body.act(actions);
  }

  private explore(world: Surroundings, actions: NPCAction[]): void {
    if (this.task?.kind === 'explore' && this.walking) return;
    const pose = this.body.pose();
    const at = pose?.position ?? world.home;
    let target: Vec3 | null = null;
    for (let tries = 0; tries < 8 && !target; tries++) {
      const angle = this.rng.next() * Math.PI * 2;
      const radius = EXPLORE_RADIUS * Math.sqrt(this.rng.next());
      const x = world.home[0] + Math.cos(angle) * radius;
      const z = world.home[2] + Math.sin(angle) * radius;
      if (dist2d([x, 0, z], at) >= 1.5 && world.walkable(x, z)) target = [x, world.ground(x, z), z];
    }
    if (!target) {
      this.task = null;
      this.stopAnd('stand', actions);
      return;
    }
    this.task = { kind: 'explore', target };
    this.moveTo(target, EXPLORE_SPEED, actions);
  }

  private greet(world: Surroundings, actions: NPCAction[]): void {
    const visitor = world.visitor;
    const pose = this.body.pose();
    if (!visitor || !pose) {
      this.task = null;
      this.stopAnd('stand', actions);
      return;
    }
    if (dist2d(pose.position, visitor.position) <= ARRIVED) {
      if (this.task?.kind === 'greet' && this.task.target) this.arrive(this.task, world, pose.position);
      else {
        this.task = null;
        this.stopAnd('stand', actions);
        this.body.face(visitor.position);
      }
      return;
    }
    const target = this.near(visitor.position, pose.position, NEAR_OWNER, world);
    const previous = this.task?.kind === 'greet' ? this.task.target : null;
    this.task = { kind: 'greet', visitor: visitor.id, target };
    if (this.stale(previous, target, GREET_SPEED)) this.moveTo(target, GREET_SPEED, actions);
  }

  private rest(world: Surroundings, actions: NPCAction[]): void {
    const pose = this.body.pose();
    if (this.task?.kind === 'rest') return;
    const home: Vec3 = [world.home[0], world.ground(world.home[0], world.home[2]), world.home[2]];
    if (!pose || dist2d(pose.position, home) <= 0.6) {
      this.task = { kind: 'rest', target: null, arrived: true };
      this.stopAnd('down', actions);
      return;
    }
    this.task = { kind: 'rest', target: home, arrived: false };
    this.moveTo(home, HOME_SPEED, actions);
  }

  private arrive(task: Task, world: Surroundings, at: Vec3): void {
    const actions: NPCAction[] = [];
    switch (task.kind) {
      case 'come':
        if (world.owner && dist2d(at, world.owner.position) > ARRIVED * 1.5) return;
        this.task = null;
        if (world.owner) this.body.face(world.owner.position);
        break;
      case 'explore':
        this.task = null;
        break;
      case 'greet': {
        this.task = null;
        if (world.visitor) this.body.face(world.visitor.position);
        if (this.pose.has('jump')) this.pose.queue('jump', this.now);
        this.events.reward?.(GREET_REWARD);
        break;
      }
      case 'rest':
        task.arrived = true;
        this.pose.settle('down', this.now, actions);
        break;
      default:
        return;
    }
    if (actions.length) this.body.act(actions);
  }

  private dropBall(world: Surroundings): void {
    const ball = this.ball;
    const pose = this.body.pose();
    if (!ball) return;
    ball.held = false;
    ball.flight = null;
    if (pose) {
      const [x, , z] = this.mouth(pose);
      ball.at = [x, world.ground(x, z) + BALL_RADIUS, z];
    }
  }

  private flyBall(world: Surroundings): void {
    const flight = this.ball?.flight;
    if (!this.ball || !flight) return;
    const u = Math.min(1, (this.now - flight.at) / THROW_SECONDS);
    const { from, to } = flight;
    const lift = 4 * THROW_ARC * u * (1 - u);
    this.ball.at = [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u + lift, from[2] + (to[2] - from[2]) * u];
    if (u >= 1) {
      this.ball.flight = null;
      this.ball.at = [to[0], world.ground(to[0], to[2]) + BALL_RADIUS, to[2]];
    }
  }

  /** Where the ball sits in the pet's mouth. */
  private mouth(pose: { position: Vec3; yaw: number }): Vec3 {
    const [fx, fz] = forward(pose.yaw);
    const { ahead, up } = this.motion.mouth;
    return [pose.position[0] + fx * ahead, pose.position[1] + up, pose.position[2] + fz * ahead];
  }

  /** A spot `gap` meters from `who`, on the side the pet comes from, on the ground. */
  private near(who: Vec3, from: Vec3, gap: number, world: Surroundings): Vec3 {
    const dx = from[0] - who[0];
    const dz = from[2] - who[2];
    const length = Math.hypot(dx, dz) || 1;
    const x = who[0] + (dx / length) * gap;
    const z = who[2] + (dz / length) * gap;
    return [x, world.ground(x, z), z];
  }

  /** Behind the owner (or beside them where that is not open ground). */
  private behind(owner: { position: Vec3; yaw: number }, world: Surroundings): Vec3 {
    const [fx, fz] = forward(owner.yaw);
    const options: [number, number][] = [
      [-fx, -fz],
      [fz, -fx],
      [-fz, fx],
    ];
    for (const [dx, dz] of options) {
      const x = owner.position[0] + dx * BEHIND_OWNER;
      const z = owner.position[2] + dz * BEHIND_OWNER;
      if (world.walkable(x, z)) return [x, world.ground(x, z), z];
    }
    const [x, , z] = owner.position;
    return [x, world.ground(x, z), z];
  }
}
