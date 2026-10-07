import type { NPCAction } from 'gaesup-world';

import type { PetFrame, PetFrameClip } from '../games/protocol';
import { PetPose, type BreedMotion, type PetBody, type PetMotor, type Vec3 } from './motor';

/**
 * The pet between pages. The owner's page runs it and relays a frame over the island's game socket (`PetRelaySender`):
 * five a second while it moves, ten while the ball flies, once a second while it stands, and soon after anything a
 * visitor would see changes. Each visitor's page plays the frames on its own NPC (`PetPuppet`): it walks to where the
 * pet is (a little ahead of it, so it keeps up), takes the posture the frame names, plays each gesture once, and puts
 * the pet where it is when it is far off. With no owner page relaying it, the pet rests at home.
 */

/** Seconds between frames: moving, the ball in the air, standing still; and after a change, at least this. */
const EVERY_MOVING = 0.2;
const EVERY_FLYING = 0.1;
const EVERY_STILL = 1;
const AFTER_CHANGE = 0.1;
/** A visitor's pet farther than this from the relayed one is put there at once. */
export const SNAP_METERS = 6;
/** It walks toward where the pet will be this many seconds on. */
const LEAD_SECONDS = 0.3;
/** Standing still, it walks over when it is farther than this from the relayed spot. */
const STILL_SLACK = 0.35;
/** Without a frame for this long, the owner's page is gone (closed, hidden, cut off): the pet rests at home. */
export const LOST_SECONDS = 12;
const HOME_SPEED = 2.2;

const dist2d = (a: readonly number[], b: readonly number[]) => Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const roundPoint = (point: Vec3): Vec3 => [round(point[0]), round(point[1]), round(point[2])];

/** The frame the owner's page relays now, or null before the pet stands anywhere. */
export function petFrame(id: string, t: number, body: PetBody, motor: PetMotor): PetFrame | null {
  const pose = body.pose();
  if (!pose) return null;
  const moving = body.moving();
  const { clip, speed } = motor.movement;
  const gesture = motor.pose.lastGesture;
  const ball = motor.ball;
  return {
    id,
    t: round(t, 2),
    at: roundPoint(pose.position),
    ry: round(pose.yaw),
    move: moving,
    speed: moving ? round(Math.min(30, speed), 2) : 0,
    clip: moving ? clip : motor.pose.stillClip(),
    gesture: gesture ? { clip: gesture.clip, at: round(gesture.at, 2) } : null,
    ball: ball ? { at: roundPoint(ball.at), held: ball.held } : null,
  };
}

/** Decides when the owner's page sends the next frame. */
export class PetRelaySender {
  private sentAt = Number.NEGATIVE_INFINITY;
  private last: PetFrame | null = null;

  constructor(private readonly send: (pet: PetFrame | null) => boolean) {}

  /** Sends `frame` (made at `now`, seconds) if one is due; true when it went. `flying`: the ball is in the air. */
  offer(now: number, frame: PetFrame, flying = false): boolean {
    // A few milliseconds of slack, so frames drawn at 60 a second still send five a second, not every thirteenth.
    const since = now - this.sentAt + 0.005;
    const every = flying ? EVERY_FLYING : frame.move ? EVERY_MOVING : EVERY_STILL;
    if (since < every && !(since >= AFTER_CHANGE && this.changed(frame))) return false;
    if (!this.send(frame)) return false;
    this.sentAt = now;
    this.last = frame;
    return true;
  }

  /** The page lets go of the pet (leaving, or another page relays it): visitors see it rest. */
  letGo(): void {
    if (this.last) this.send(null);
    this.last = null;
    this.sentAt = Number.NEGATIVE_INFINITY;
  }

  /** Whether a visitor would see a difference: moving or not, the clip, a new gesture, the ball. */
  private changed(frame: PetFrame): boolean {
    const last = this.last;
    if (!last) return true;
    return (
      last.move !== frame.move ||
      last.clip !== frame.clip ||
      last.gesture?.at !== frame.gesture?.at ||
      !last.ball !== !frame.ball ||
      last.ball?.held !== frame.ball?.held
    );
  }
}

/** The posture a still frame's clip shows. */
export function postureOf(clip: PetFrameClip): 'stand' | 'sit' | 'down' {
  if (clip === 'sit_hold' || clip === 'sit') return 'sit';
  if (clip === 'lie_hold' || clip === 'lie') return 'down';
  return 'stand';
}

/** The visitors' pet: an NPC that plays the owner page's frames. */
export class PetPuppet {
  readonly pose: PetPose;
  /** The ball as drawn here, or null. */
  ball: { at: Vec3; held: boolean } | null = null;
  private ballGoal: { at: Vec3; held: boolean } | null = null;
  private now = 0;
  private lastT = Number.NEGATIVE_INFINITY;
  /** The last frame's gesture time; undefined before the first frame, so a gesture already past is not replayed. */
  private lastGestureAt: number | null | undefined = undefined;
  private lastFrameAt = Number.NEGATIVE_INFINITY;
  private live = false;
  private walking: { target: Vec3; clip: string } | null = null;
  private arrival: { posture: 'stand' | 'sit' | 'down'; yaw: number | null; leadIn: boolean } | null = null;

  constructor(
    private readonly body: PetBody,
    private readonly motion: BreedMotion,
    private readonly home: Vec3,
    /** Turns the engine's idle gestures (a bark now and then) on while it rests at home, off while relayed. */
    private readonly restGestures: (on: boolean) => void = () => {},
  ) {
    this.pose = new PetPose(body, motion);
  }

  /** Whether frames are coming from the owner's page. */
  get relayed(): boolean {
    return this.live;
  }

  /** The pet resting at home, as it is when nobody relays it. */
  rest(): void {
    const actions: NPCAction[] = [];
    this.live = false;
    this.ballGoal = null;
    this.ball = null;
    const pose = this.body.pose();
    if (!pose || dist2d(pose.position, this.home) <= 0.6) {
      this.walking = null;
      this.pose.settle('down', this.now, actions, { gesture: false });
      this.restGestures(true);
    } else {
      this.walkTo(this.home, HOME_SPEED, 'walk', actions);
      this.arrival = { posture: 'down', yaw: null, leadIn: true };
    }
    if (actions.length) this.body.act(actions);
  }

  /** A frame from the owner's page, or null when it let go of the pet. */
  apply(frame: PetFrame | null): void {
    if (frame === null) {
      this.lastT = Number.NEGATIVE_INFINITY;
      this.rest();
      return;
    }
    // An older frame arrived late; a much older clock is the owner's page started over.
    if (frame.t <= this.lastT && frame.t > this.lastT - 2) return;
    this.lastT = frame.t;
    this.lastFrameAt = this.now;
    if (!this.live) {
      this.live = true;
      this.restGestures(false);
    }
    const gesture = frame.gesture;
    const fresh = !!gesture && this.lastGestureAt !== undefined && gesture.at !== this.lastGestureAt;
    this.lastGestureAt = gesture?.at ?? null;
    this.ballGoal = frame.ball ? { at: [...frame.ball.at], held: frame.ball.held } : null;
    if (!this.ballGoal) this.ball = null;

    const actions: NPCAction[] = [];
    const pose = this.body.pose();
    if (!pose || dist2d(pose.position, frame.at) > SNAP_METERS) {
      this.body.place([...frame.at], frame.ry);
      this.walking = null;
    }
    const at = this.body.pose()?.position ?? frame.at;
    if (frame.move) {
      const lead = frame.speed * LEAD_SECONDS;
      const target: Vec3 = [frame.at[0] + Math.sin(frame.ry) * lead, frame.at[1], frame.at[2] + Math.cos(frame.ry) * lead];
      const clip = frame.clip === 'run' ? 'run' : 'walk';
      this.arrival = null;
      if (!this.walking || this.walking.clip !== clip || dist2d(this.walking.target, target) > 0.3) {
        this.walkTo(target, Math.max(0.5, frame.speed * 1.05), clip, actions);
      }
    } else {
      const posture = postureOf(frame.clip);
      const leadIn = fresh && (gesture?.clip === 'sit' || gesture?.clip === 'lie');
      const distance = dist2d(at, frame.at);
      if (distance > STILL_SLACK) {
        this.walkTo([...frame.at], Math.max(1.5, distance * 2.5), 'walk', actions);
        this.arrival = { posture, yaw: frame.ry, leadIn };
      } else {
        this.walking = null;
        this.arrival = null;
        this.pose.settle(posture, this.now, actions, { gesture: leadIn });
        this.faceYaw(frame.ry, at);
      }
    }
    if (fresh && gesture && (gesture.clip === 'bark' || gesture.clip === 'jump') && this.pose.has(gesture.clip)) {
      this.pose.queue(gesture.clip, this.now);
    }
    if (actions.length) this.body.act(actions);
  }

  /** Every frame: gestures and holds, arriving, the ball's drawn place, and an owner page that went quiet. */
  tick(dt: number): void {
    this.now += Math.max(0, Math.min(dt, 0.25));
    this.pose.tick(this.now);
    if (this.live && this.now - this.lastFrameAt > LOST_SECONDS) this.rest();
    const pose = this.body.pose();
    if (this.walking && !this.body.moving()) {
      this.walking = null;
      const arrival = this.arrival;
      this.arrival = null;
      if (arrival) {
        const actions: NPCAction[] = [];
        this.pose.settle(arrival.posture, this.now, actions, { gesture: arrival.leadIn });
        if (actions.length) this.body.act(actions);
        if (pose && arrival.yaw !== null) this.faceYaw(arrival.yaw, pose.position);
        if (!this.live) this.restGestures(true);
      }
    }
    this.moveBall(dt, pose);
  }

  private walkTo(target: Vec3, speed: number, clip: 'walk' | 'run', actions: NPCAction[]): void {
    this.pose.beforeMove(actions);
    this.walking = { target, clip };
    actions.push({ type: 'moveTo', target, speed: Math.min(30, speed), animationId: clip });
  }

  private faceYaw(yaw: number, at: readonly number[]): void {
    this.body.face([(at[0] ?? 0) + Math.sin(yaw), at[1] ?? 0, (at[2] ?? 0) + Math.cos(yaw)]);
  }

  private moveBall(dt: number, pose: { position: Vec3; yaw: number } | null): void {
    const goal = this.ballGoal;
    if (!goal) return;
    if (goal.held && pose) {
      const { ahead, up } = this.motion.mouth;
      this.ball = {
        held: true,
        at: [pose.position[0] + Math.sin(pose.yaw) * ahead, pose.position[1] + up, pose.position[2] + Math.cos(pose.yaw) * ahead],
      };
      return;
    }
    if (!this.ball || this.ball.held || dist2d(this.ball.at, goal.at) > SNAP_METERS) {
      this.ball = { at: [...goal.at], held: goal.held };
      return;
    }
    // Frames come a few times a second; in between the ball eases toward the last one.
    const k = 1 - Math.exp(-dt * 12);
    const at = this.ball.at;
    this.ball = { held: false, at: [at[0] + (goal.at[0] - at[0]) * k, at[1] + (goal.at[1] - at[1]) * k, at[2] + (goal.at[2] - at[2]) * k] };
  }
}
