/**
 * Every number the pets' brain, drives, commands and training use, in one place. They are game design, tuned by the
 * learning tests (`__tests__/learning.test.ts`); none of them is measured from a fly or a dog.
 */

// --- Senses (`senses.ts`) ---------------------------------------------------------------------------------------
/** ownerNear = exp(−d / OWNER_NEAR_METERS). */
export const OWNER_NEAR_METERS = 3;
/** ownerFar = min(1, d / OWNER_FAR_METERS). */
export const OWNER_FAR_METERS = 12;
/** ownerMoving = min(1, speed / OWNER_SPEED_FULL), in m/s. */
export const OWNER_SPEED_FULL = 4;
/** ball = exp(−d / BALL_METERS) while a ball lies on the ground. */
export const BALL_METERS = 5;
/** visitorNear = exp(−d / VISITOR_METERS) for the nearest visitor. */
export const VISITOR_METERS = 4;
/** visitorNew is 1 for VISITOR_NEW_SECONDS after a visitor comes within VISITOR_NEW_RADIUS meters. */
export const VISITOR_NEW_RADIUS = 8;
export const VISITOR_NEW_SECONDS = 4;
/** bored = seconds since the owner last interacted / BORED_SECONDS, at most 1. */
export const BORED_SECONDS = 120;
/** Island hours that count as night: from NIGHT_FROM_HOUR to NIGHT_TO_HOUR. */
export const NIGHT_FROM_HOUR = 22;
export const NIGHT_TO_HOUR = 6;
/** A cue sense at or above this counts as a command in force. */
export const CUE_ON = 0.5;

// --- Circuit dynamics (`brain.ts`; 초켓몬스터's Brain) ------------------------------------------------------------
/** a ← ACTIVITY_DECAY·a + ACTIVITY_GAIN·tanh(W_in·x + W_rec·a), MICROSTEPS times a decision. */
export const ACTIVITY_DECAY = 0.35;
export const ACTIVITY_GAIN = 0.65;
export const MICROSTEPS = 4;
/** Readout features are φ = [1, FEATURE_SCALE·a]. */
export const FEATURE_SCALE = 0.35;
/** Input projection weights are uniform in ±INPUT_SPREAD, drawn from the pet's seed. */
export const INPUT_SPREAD = 0.6;
/** Readout weights start uniform in ±READOUT_INIT. */
export const READOUT_INIT = 0.01;

// --- Learning (`brain.ts`) ---------------------------------------------------------------------------------------
/** η of W_out += η·δ·E / (1 + |φ|²). */
export const LEARNING_RATE = 0.3;
/** γ, the discount of the next decision's value. */
export const DISCOUNT = 0.8;
/** λ: eligibility decays by γλ a decision, so a treat a second or two late still credits what the pet just did. */
export const TRACE_DECAY = 0.7;
/** δ is clamped to ±TD_ERROR_LIMIT and readout weights to ±WEIGHT_LIMIT (the server checks the same bound). */
export const TD_ERROR_LIMIT = 4;
export const WEIGHT_LIMIT = 12;

// --- Choice (`brain.ts`) -----------------------------------------------------------------------------------------
/** The brain decides at 2 Hz. */
export const DECISION_SECONDS = 0.5;
/**
 * ε-greedy: a random legal action with this chance when no command is in force, and when one is (then one of the
 * answers in `OFFERS`: the pet offers what it might be asked for). While it holds a posture, option or gesture it only
 * breaks off at EPSILON_HELD, so a sit lasts until the treat.
 */
export const EPSILON_FREE = 0.06;
export const EPSILON_CUED = 0.3;
export const EPSILON_HELD = 0.06;
/** A held posture or option (sit, down, rest; come, fetch, greet, explore) gives way only to a value this much higher. */
export const SWITCH_MARGIN = 0.15;

// --- Innate preferences (`innate.ts`); outside the circuit ------------------------------------------------------
export const INNATE_STAND = 0.1;
/** × sociability × ownerFar */
export const INNATE_COME = 0.45;
/** × curiosity × bored */
export const INNATE_EXPLORE = 0.25;
/** × sociability × visitorNew */
export const INNATE_GREET = 0.35;
/** × playfulness × ball */
export const INNATE_FETCH = 0.3;
/** sleepiness × (INNATE_REST_TIRED·(1 − energy) + INNATE_REST_NIGHT·night) */
export const INNATE_REST_TIRED = 0.5;
export const INNATE_REST_NIGHT = 0.3;
/** Each temperament factor (sociability, curiosity, playfulness, sleepiness) is uniform in this range. */
export const TEMPERAMENT_MIN = 0.8;
export const TEMPERAMENT_MAX = 1.2;

// --- Rewards ---------------------------------------------------------------------------------------------------
/** A treat is worth TREAT_REWARD × clamp(TREAT_PIVOT − satiety, TREAT_MIN_SHARE, 1). */
export const TREAT_REWARD = 1;
export const TREAT_PIVOT = 1.2;
export const TREAT_MIN_SHARE = 0.2;
export const PRAISE_REWARD = 0.5;
export const PAT_REWARD = 0.3;
/** "안돼": words only, and weak. */
export const SCOLD_REWARD = -0.6;
/** Each decision a trick (sit, down, speak, jump) is done with no command in force. */
export const UNCUED_TRICK_REWARD = -0.05;
/** Each decision spent resting while energy is below REST_TIRED_BELOW. */
export const REST_TIRED_REWARD = 0.05;
export const REST_TIRED_BELOW = 0.3;
/** Each decision spent exploring while bored is at least EXPLORE_BORED_FROM. */
export const EXPLORE_BORED_REWARD = 0.02;
export const EXPLORE_BORED_FROM = 0.5;
/** Once, when the pet reaches a visitor it went to greet / picks up the ball. */
export const GREET_REWARD = 0.1;
export const BALL_PICKUP_REWARD = 0.2;

// --- Drives (`drives.ts`); not learned ----------------------------------------------------------------------------
/** Energy a second while moving, and while resting at home. Standing, sitting and gestures leave it alone. */
export const ENERGY_MOVE_PER_SECOND = -0.004;
export const ENERGY_REST_PER_SECOND = 0.01;
/** Resting at home is over (no longer held) once energy is back to this. */
export const RESTED_ENERGY = 0.95;
/** Satiety a minute, down to SATIETY_FLOOR. */
export const SATIETY_PER_MINUTE = -0.06;
export const SATIETY_FLOOR = 0.2;
/** What each treat adds. */
export const TREAT_SATIETY = 0.12;
export const TREAT_MOOD = 0.05;
export const PRAISE_MOOD = 0.03;
export const PRAISE_BOND = 0.01;
export const PAT_MOOD = 0.04;
export const PAT_BOND = 0.02;
export const SCOLD_MOOD = -0.1;
export const SCOLD_BOND = -0.03;
/** Bond gained in one day (KST) stops here. */
export const BOND_PER_DAY = 0.2;
export const DAY_OFFSET_MS = 9 * 3600 * 1000;
/** Mood drifts back toward MOOD_BASELINE by this much a minute. */
export const MOOD_BASELINE = 0.6;
export const MOOD_DRIFT_PER_MINUTE = 0.01;
/** A new pet. */
export const DEFAULT_ENERGY = 1;
export const DEFAULT_SATIETY = 0.5;
export const DEFAULT_MOOD = 0.6;
export const DEFAULT_BOND = 0.1;
/** Offline catch-up counts at most this long. */
export const CATCH_UP_MAX_SECONDS = 7 * 24 * 3600;

// --- Commands and feedback (controller) --------------------------------------------------------------------------
/** How long a command stays in force without feedback or a new command, in seconds; fetch lasts until the ball is back. */
export const COMMAND_SECONDS = { come: 3, sit: 10, down: 10, stay: 30, fetch: Number.POSITIVE_INFINITY, speak: 3, jump: 3 } as const;
/** The same command again within this many seconds is ignored. */
export const COMMAND_REPEAT_SECONDS = 0.5;
/** Treats are off at this satiety and above, and past TREATS_PER_HOUR in the last hour. */
export const TREAT_FULL = 0.95;
export const TREATS_PER_HOUR = 40;
/** Learning stays on for this long after the owner last interacted. */
export const LEARNING_IDLE_SECONDS = 120;

// --- Mastery (`probes.ts`) ---------------------------------------------------------------------------------------
/** Fixed contexts a command's mastery is measured on: a grid of 18 plus seeded ones. */
export const PROBE_COUNT = 24;
export const PROBE_SEED = 0x5eed_d06;
/** A command counts as learned at this share of correct probe responses… */
export const MASTERY_GOAL = 0.8;
/** …while the trick, uncued, is chosen in at most this share of probes. */
export const UNCUED_LIMIT = 0.2;

// --- Scripted trainer (`trainer.ts`) -----------------------------------------------------------------------------
/** Seconds between a right response and its reward, free time between trials, and how long a stay must hold. */
export const TRAINER_REWARD_DELAY = 1;
export const TRAINER_FREE_SECONDS = 3;
export const TRAINER_STAY_SECONDS = 2;
