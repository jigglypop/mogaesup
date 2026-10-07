import {
  BOND_PER_DAY,
  CATCH_UP_MAX_SECONDS,
  DAY_OFFSET_MS,
  DEFAULT_BOND,
  DEFAULT_ENERGY,
  DEFAULT_MOOD,
  DEFAULT_SATIETY,
  ENERGY_MOVE_PER_SECOND,
  ENERGY_REST_PER_SECOND,
  MOOD_BASELINE,
  MOOD_DRIFT_PER_MINUTE,
  PAT_BOND,
  PAT_MOOD,
  PAT_REWARD,
  PRAISE_BOND,
  PRAISE_MOOD,
  PRAISE_REWARD,
  SATIETY_FLOOR,
  SATIETY_PER_MINUTE,
  SCOLD_BOND,
  SCOLD_MOOD,
  SCOLD_REWARD,
  TREAT_FULL,
  TREAT_MIN_SHARE,
  TREAT_MOOD,
  TREAT_PIVOT,
  TREAT_REWARD,
  TREAT_SATIETY,
  TREATS_PER_HOUR,
} from './brain/constants';
import type { PetAction } from './brain/senses';

/**
 * A pet's drives, each 0..1. Energy and satiety are senses the brain reads; mood and bond only change with the owner's
 * feedback (and mood drifts back to its baseline). None of them is learned.
 */
export type PetDrives = { energy: number; satiety: number; mood: number; bond: number };
/** What the body is doing for energy's sake. */
export type DriveActivity = 'move' | 'still' | 'rest';
export type PetFeedback = 'treat' | 'praise' | 'pat' | 'scold';
/** Bond gained on one (KST) day, for the daily cap. */
export type BondLedger = { day: number; gained: number };

export const DRIVE_KEYS = ['energy', 'satiety', 'mood', 'bond'] as const;
export const DEFAULT_DRIVES: Readonly<PetDrives> = Object.freeze({
  energy: DEFAULT_ENERGY,
  satiety: DEFAULT_SATIETY,
  mood: DEFAULT_MOOD,
  bond: DEFAULT_BOND,
});
/** Treats, praise and "안돼" end the trial they answer; a pat does not. */
export const FEEDBACK_TERMINAL: Readonly<Record<PetFeedback, boolean>> = { treat: true, praise: true, pat: false, scold: true };

const unit = (value: number) => Math.min(1, Math.max(0, value));
const MINUTE = 60;
const DAY_MS = 24 * 3600 * 1000;

/** Saved drives (the server's `drives`, `{}` for a new pet): each valid value kept, the rest from the defaults. */
export function readDrives(value: unknown): PetDrives {
  const saved = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const read = (key: (typeof DRIVE_KEYS)[number]) => {
    const drive = saved[key];
    return typeof drive === 'number' && Number.isFinite(drive) ? unit(drive) : DEFAULT_DRIVES[key];
  };
  return { energy: read('energy'), satiety: read('satiety'), mood: read('mood'), bond: read('bond') };
}

/** Moving tires the pet, resting at home restores it; standing, sitting and gestures leave energy alone. */
export function driveActivity(action: PetAction | null, moving: boolean): DriveActivity {
  if (moving) return 'move';
  return action === 'rest' ? 'rest' : 'still';
}

/** Drives after `seconds` of `activity`. */
export function stepDrives(drives: PetDrives, seconds: number, activity: DriveActivity): PetDrives {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return drives;
  const energyRate = activity === 'move' ? ENERGY_MOVE_PER_SECOND : activity === 'rest' ? ENERGY_REST_PER_SECOND : 0;
  const hungrier = drives.satiety + (SATIETY_PER_MINUTE * seconds) / MINUTE;
  const drift = (MOOD_DRIFT_PER_MINUTE * seconds) / MINUTE;
  return {
    energy: unit(drives.energy + energyRate * seconds),
    satiety: drives.satiety <= SATIETY_FLOOR ? drives.satiety : Math.max(SATIETY_FLOOR, hungrier),
    mood: drives.mood > MOOD_BASELINE ? Math.max(MOOD_BASELINE, drives.mood - drift) : Math.min(MOOD_BASELINE, drives.mood + drift),
    bond: drives.bond,
  };
}

/** Back after `seconds` away (at most a week counts): the pet rested at home, so energy is back and satiety is down. */
export function catchUpDrives(drives: PetDrives, seconds: number): PetDrives {
  const away = Number.isFinite(seconds) ? Math.min(CATCH_UP_MAX_SECONDS, Math.max(0, seconds)) : 0;
  return stepDrives(drives, away, 'rest');
}

/** What a treat teaches: less the fuller the pet is. */
export function treatValue(satiety: number): number {
  return TREAT_REWARD * Math.min(1, Math.max(TREAT_MIN_SHARE, TREAT_PIVOT - satiety));
}

/** Treats are off from TREAT_FULL satiety and after TREATS_PER_HOUR in the last hour. */
export function treatAllowed(satiety: number, treatsInLastHour: number): boolean {
  return satiety < TREAT_FULL && treatsInLastHour < TREATS_PER_HOUR;
}

/** The KST day a time (ms since the epoch) falls on. */
export function dayOf(now: number): number {
  return Math.floor((now + DAY_OFFSET_MS) / DAY_MS);
}

export type FeedbackResult = {
  drives: PetDrives;
  ledger: BondLedger;
  /** For `PetBrain.reward(reward, terminal)`. */
  reward: number;
  terminal: boolean;
};

/**
 * The owner's feedback: its reward for the brain and what it does to the drives. A treat is worth less the fuller the
 * pet is (it is checked against `treatAllowed` before); praise and pats raise mood and bond, bond by at most
 * BOND_PER_DAY a day; "안돼" lowers both.
 */
export function applyFeedback(drives: PetDrives, kind: PetFeedback, ledger: BondLedger, now: number): FeedbackResult {
  const day = dayOf(now);
  const gained = ledger.day === day ? ledger.gained : 0;
  let { satiety, mood } = drives;
  let reward: number;
  let bondChange = 0;
  switch (kind) {
    case 'treat':
      reward = treatValue(satiety);
      satiety += TREAT_SATIETY;
      mood += TREAT_MOOD;
      break;
    case 'praise':
      reward = PRAISE_REWARD;
      mood += PRAISE_MOOD;
      bondChange = PRAISE_BOND;
      break;
    case 'pat':
      reward = PAT_REWARD;
      mood += PAT_MOOD;
      bondChange = PAT_BOND;
      break;
    case 'scold':
      reward = SCOLD_REWARD;
      mood += SCOLD_MOOD;
      bondChange = SCOLD_BOND;
      break;
  }
  if (bondChange > 0) bondChange = Math.min(bondChange, Math.max(0, BOND_PER_DAY - gained));
  const bond = unit(drives.bond + bondChange);
  return {
    drives: { energy: drives.energy, satiety: unit(satiety), mood: unit(mood), bond },
    ledger: { day, gained: gained + Math.max(0, bond - drives.bond) },
    reward,
    terminal: FEEDBACK_TERMINAL[kind],
  };
}
