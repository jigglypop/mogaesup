import {
  EXPLORE_BORED_FROM,
  EXPLORE_BORED_REWARD,
  INNATE_COME,
  INNATE_EXPLORE,
  INNATE_FETCH,
  INNATE_GREET,
  INNATE_REST_NIGHT,
  INNATE_REST_TIRED,
  INNATE_STAND,
  REST_TIRED_BELOW,
  REST_TIRED_REWARD,
  TEMPERAMENT_MAX,
  TEMPERAMENT_MIN,
  UNCUED_TRICK_REWARD,
} from './constants';
import { Random, deriveSeed } from './random';
import { ACTION, ACTION_COUNT, SENSE, TRICKS, cueOf, type PetAction } from './senses';

/**
 * Innate preferences: fixed, hand-written rules added to the learned readout (game design, outside the circuit). A pet
 * comes to a distant owner, looks around when bored, greets new visitors, chases a ball and rests when tired without
 * training; sit, down, speak and jump start at zero and only training brings them out.
 */
export type Temperament = {
  sociability: number;
  curiosity: number;
  playfulness: number;
  sleepiness: number;
};

/** Seed stream for the temperament (`deriveSeed`). */
const TEMPERAMENT_STREAM = 3;

/** Each factor uniform in [TEMPERAMENT_MIN, TEMPERAMENT_MAX], from the pet's seed. */
export function temperamentFor(seed: number): Temperament {
  const rng = new Random(deriveSeed(seed, TEMPERAMENT_STREAM));
  const factor = () => rng.range(TEMPERAMENT_MIN, TEMPERAMENT_MAX);
  return { sociability: factor(), curiosity: factor(), playfulness: factor(), sleepiness: factor() };
}

/** Writes each action's innate value for `senses` into `out` (ACTIONS order). */
export function innateValues(senses: Float32Array, temperament: Temperament, out: Float64Array): Float64Array {
  if (out.length !== ACTION_COUNT) throw new RangeError('One innate value per action');
  out.fill(0);
  out[ACTION.stand] = INNATE_STAND;
  out[ACTION.come] = INNATE_COME * temperament.sociability * senses[SENSE.ownerFar]!;
  out[ACTION.fetch] = INNATE_FETCH * temperament.playfulness * senses[SENSE.ball]!;
  out[ACTION.explore] = INNATE_EXPLORE * temperament.curiosity * senses[SENSE.bored]!;
  out[ACTION.greet] = INNATE_GREET * temperament.sociability * senses[SENSE.visitorNew]!;
  out[ACTION.rest] =
    temperament.sleepiness * (INNATE_REST_TIRED * (1 - senses[SENSE.energy]!) + INNATE_REST_NIGHT * senses[SENSE.night]!);
  return out;
}

/**
 * The pet's own reward for one decision's action under the senses it was chosen on: a trick with no command in force
 * costs a little, resting while tired and exploring while bored pay a little. Give it to `PetBrain.reward` right after
 * `decide`. Greeting a visitor (`GREET_REWARD`) and picking up the ball (`BALL_PICKUP_REWARD`) are paid once, when they
 * happen.
 */
export function intrinsicReward(action: PetAction, senses: Float32Array): number {
  if (TRICKS.includes(action)) return cueOf(senses) === null ? UNCUED_TRICK_REWARD : 0;
  if (action === 'rest') return senses[SENSE.energy]! < REST_TIRED_BELOW ? REST_TIRED_REWARD : 0;
  if (action === 'explore') return senses[SENSE.bored]! >= EXPLORE_BORED_FROM ? EXPLORE_BORED_REWARD : 0;
  return 0;
}
