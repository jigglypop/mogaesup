import {
  BALL_METERS,
  BORED_SECONDS,
  CUE_ON,
  NIGHT_FROM_HOUR,
  NIGHT_TO_HOUR,
  OWNER_FAR_METERS,
  OWNER_NEAR_METERS,
  OWNER_SPEED_FULL,
  VISITOR_METERS,
} from './constants';

/**
 * What a pet senses each decision: 20 hand-made values (game design, no anatomical mapping). They reach the circuit
 * through the pet's own random input projection.
 */
export const SENSES = [
  'bias',
  'ownerNear',
  'ownerFar',
  'ownerSin',
  'ownerCos',
  'ownerMoving',
  'cueCome',
  'cueSit',
  'cueDown',
  'cueStay',
  'cueFetch',
  'cueSpeak',
  'cueJump',
  'ball',
  'visitorNear',
  'visitorNew',
  'energy',
  'satiety',
  'bored',
  'night',
] as const;
export type SenseName = (typeof SENSES)[number];
export const SENSE_COUNT = SENSES.length;
export const SENSE = Object.fromEntries(SENSES.map((name, index) => [name, index])) as Record<SenseName, number>;

/** What a pet can do; the brain's output, one value each. */
export const ACTIONS = ['stand', 'come', 'sit', 'down', 'speak', 'jump', 'fetch', 'explore', 'greet', 'rest'] as const;
export type PetAction = (typeof ACTIONS)[number];
export const ACTION_COUNT = ACTIONS.length;
export const ACTION = Object.fromEntries(ACTIONS.map((name, index) => [name, index])) as Record<PetAction, number>;

/** What the owner can ask, in the order of the cue senses. */
export const COMMANDS = ['come', 'sit', 'down', 'stay', 'fetch', 'speak', 'jump'] as const;
export type PetCommand = (typeof COMMANDS)[number];
export const CUE: Record<PetCommand, number> = {
  come: SENSE.cueCome,
  sit: SENSE.cueSit,
  down: SENSE.cueDown,
  stay: SENSE.cueStay,
  fetch: SENSE.cueFetch,
  speak: SENSE.cueSpeak,
  jump: SENSE.cueJump,
};

/** Tricks have no innate pull: a pet does them because it was trained to, and doing one unasked costs a little. */
export const TRICKS: readonly PetAction[] = ['sit', 'down', 'speak', 'jump'];
/**
 * Actions that last until something better is clearly worth switching to (`SWITCH_MARGIN`): postures, options in
 * progress, and a bark or jump while its clip plays.
 */
export const HELD_ACTIONS: readonly PetAction[] = ['sit', 'down', 'rest', 'come', 'fetch', 'greet', 'explore', 'speak', 'jump'];
/** What a pet tries, when it explores while a command is in force: answers it might be asked for, not wandering off. */
export const OFFERS: readonly PetAction[] = ['stand', 'come', 'sit', 'down', 'speak', 'jump', 'fetch'];

/** The world as the controller sees it at one decision. */
export type SenseInput = {
  /** Meters to the owner. */
  ownerDistance: number;
  /** Radians to turn by to face the owner (`bearing`): 0 straight ahead. */
  ownerBearing: number;
  /** The owner's speed, m/s. */
  ownerSpeed: number;
  /** The command in force, if any. */
  command: PetCommand | null;
  /** Meters to a ball lying on the ground; null when there is none (or the pet holds it). */
  ballDistance: number | null;
  /** Meters to the nearest visitor; null when there is none. */
  visitorDistance: number | null;
  /** A visitor came within `VISITOR_NEW_RADIUS` in the last `VISITOR_NEW_SECONDS`. */
  visitorNew: boolean;
  /** Drives, 0..1. */
  energy: number;
  satiety: number;
  /** Seconds since the owner last interacted with the pet. */
  sinceInteraction: number;
  /** Island night (`isNight`). */
  night: boolean;
};

const unit = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const near = (distance: number | null, meters: number) =>
  distance === null || !Number.isFinite(distance) ? 0 : Math.exp(-Math.max(0, distance) / meters);

/** Writes the 20 senses for `input` into `out`. */
export function sense(input: SenseInput, out: Float32Array = new Float32Array(SENSE_COUNT)): Float32Array {
  if (out.length !== SENSE_COUNT) throw new RangeError('Senses need 20 values');
  out.fill(0);
  const distance = Number.isFinite(input.ownerDistance) ? Math.max(0, input.ownerDistance) : Number.POSITIVE_INFINITY;
  const bearing = Number.isFinite(input.ownerBearing) ? input.ownerBearing : 0;
  out[SENSE.bias] = 1;
  out[SENSE.ownerNear] = Number.isFinite(distance) ? Math.exp(-distance / OWNER_NEAR_METERS) : 0;
  out[SENSE.ownerFar] = Math.min(1, distance / OWNER_FAR_METERS);
  out[SENSE.ownerSin] = Math.sin(bearing);
  out[SENSE.ownerCos] = Math.cos(bearing);
  out[SENSE.ownerMoving] = unit(input.ownerSpeed / OWNER_SPEED_FULL);
  if (input.command) out[CUE[input.command]] = 1;
  out[SENSE.ball] = near(input.ballDistance, BALL_METERS);
  out[SENSE.visitorNear] = near(input.visitorDistance, VISITOR_METERS);
  out[SENSE.visitorNew] = input.visitorNew && input.visitorDistance !== null ? 1 : 0;
  out[SENSE.energy] = unit(input.energy);
  out[SENSE.satiety] = unit(input.satiety);
  out[SENSE.bored] = unit(input.sinceInteraction / BORED_SECONDS);
  out[SENSE.night] = input.night ? 1 : 0;
  return out;
}

/** The command whose cue is on in `senses`, if any. */
export function cueOf(senses: Float32Array): PetCommand | null {
  for (const command of COMMANDS) if (senses[CUE[command]]! >= CUE_ON) return command;
  return null;
}

/** Which actions can be chosen: fetch needs a ball on the ground (or in the pet's mouth), greet a visitor. */
export function legalActions(
  senses: Float32Array,
  out: boolean[] = new Array<boolean>(ACTION_COUNT),
  options: { carryingBall?: boolean } = {},
): boolean[] {
  for (let action = 0; action < ACTION_COUNT; action++) out[action] = true;
  out[ACTION.fetch] = senses[SENSE.ball]! > 0 || options.carryingBall === true;
  out[ACTION.greet] = senses[SENSE.visitorNear]! > 0;
  return out;
}

/**
 * Radians a pet at (fromX, fromZ) facing `yaw` turns by to face (toX, toZ), in [−π, π]: `yaw + bearing` faces the
 * target, with yaw measured as the engine's rotation about Y (forward = (sin yaw, cos yaw)).
 */
export function bearing(fromX: number, fromZ: number, yaw: number, toX: number, toZ: number): number {
  const angle = Math.atan2(toX - fromX, toZ - fromZ) - yaw;
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Island hours 22–6 are night. */
export function isNight(hour: number): boolean {
  return hour >= NIGHT_FROM_HOUR || hour < NIGHT_TO_HOUR;
}
