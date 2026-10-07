import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DRIVES,
  applyFeedback,
  catchUpDrives,
  dayOf,
  driveActivity,
  readDrives,
  stepDrives,
  treatAllowed,
  treatValue,
  type BondLedger,
  type PetDrives,
} from '../drives';

const NOON_KST = Date.UTC(2026, 9, 7, 3);
const fresh = (): BondLedger => ({ day: 0, gained: 0 });

describe('펫 욕구', () => {
  it('배부를수록 간식의 학습 가치가 줄어든다', () => {
    expect(treatValue(0.2)).toBeCloseTo(1);
    expect(treatValue(0.5)).toBeCloseTo(0.7);
    expect(treatValue(0.8)).toBeCloseTo(0.4);
    expect(treatValue(1)).toBeCloseTo(0.2);
    let previous = Number.POSITIVE_INFINITY;
    for (let satiety = 0; satiety <= 1; satiety += 0.05) {
      const value = treatValue(satiety);
      expect(value).toBeLessThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(0.2);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
  });

  it('간식은 배를 채우고 기분을 올리며, 가득 차거나 한 시간에 40개를 넘으면 막힌다', () => {
    const drives: PetDrives = { energy: 0.7, satiety: 0.5, mood: 0.6, bond: 0.3 };
    const result = applyFeedback(drives, 'treat', fresh(), NOON_KST);
    expect(result.reward).toBeCloseTo(0.7);
    expect(result.terminal).toBe(true);
    expect(result.drives.satiety).toBeCloseTo(0.62);
    expect(result.drives.mood).toBeCloseTo(0.65);
    expect(result.drives.bond).toBe(0.3);
    expect(result.drives.energy).toBe(0.7);
    // Treats keep coming until the pet is full; each is worth less than the one before.
    let state = drives;
    const values: number[] = [];
    while (treatAllowed(state.satiety, values.length)) {
      const next = applyFeedback(state, 'treat', fresh(), NOON_KST);
      values.push(next.reward);
      state = next.drives;
    }
    expect(values.length).toBe(4);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(treatAllowed(0.94, 39)).toBe(true);
    expect(treatAllowed(0.95, 0)).toBe(false);
    expect(treatAllowed(0.2, 40)).toBe(false);
  });

  it('칭찬과 쓰다듬기는 기분과 친밀도를, 안돼는 둘 다 내린다', () => {
    const drives: PetDrives = { energy: 0.5, satiety: 0.5, mood: 0.6, bond: 0.5 };
    const praise = applyFeedback(drives, 'praise', fresh(), NOON_KST);
    expect([praise.reward, praise.terminal]).toEqual([0.5, true]);
    expect(praise.drives.mood).toBeGreaterThan(0.6);
    expect(praise.drives.bond).toBeGreaterThan(0.5);
    const pat = applyFeedback(drives, 'pat', fresh(), NOON_KST);
    expect([pat.reward, pat.terminal]).toEqual([0.3, false]);
    expect(pat.drives.bond).toBeGreaterThan(0.5);
    const scold = applyFeedback(drives, 'scold', fresh(), NOON_KST);
    expect([scold.reward, scold.terminal]).toEqual([-0.6, true]);
    expect(scold.drives.mood).toBeCloseTo(0.5);
    expect(scold.drives.bond).toBeCloseTo(0.47);
    expect(scold.drives.satiety).toBe(0.5);
    // Repeated scolding keeps lowering both, down to zero.
    let state = drives;
    for (let i = 0; i < 30; i++) state = applyFeedback(state, 'scold', fresh(), NOON_KST).drives;
    expect(state.mood).toBe(0);
    expect(state.bond).toBe(0);
  });

  it('친밀도는 하루(KST)에 0.2까지만 오르고 다음 날 다시 오른다', () => {
    let drives: PetDrives = { ...DEFAULT_DRIVES, bond: 0.1 };
    let ledger = fresh();
    for (let i = 0; i < 100; i++) {
      const result = applyFeedback(drives, i % 2 ? 'pat' : 'praise', ledger, NOON_KST + i * 60_000);
      drives = result.drives;
      ledger = result.ledger;
    }
    expect(drives.bond).toBeCloseTo(0.3, 9);
    expect(ledger.gained).toBeCloseTo(0.2, 9);
    // A scold still lowers bond after the cap and does not give back room.
    const scolded = applyFeedback(drives, 'scold', ledger, NOON_KST + 3 * 3600_000);
    expect(scolded.drives.bond).toBeCloseTo(0.27, 9);
    expect(applyFeedback(scolded.drives, 'pat', scolded.ledger, NOON_KST + 4 * 3600_000).drives.bond).toBeCloseTo(0.27, 9);
    // Midnight KST is 15:00 UTC.
    const tomorrow = Date.UTC(2026, 9, 7, 15, 0, 1);
    expect(dayOf(tomorrow)).toBe(dayOf(NOON_KST) + 1);
    expect(dayOf(Date.UTC(2026, 9, 7, 14, 59, 59))).toBe(dayOf(NOON_KST));
    const nextDay = applyFeedback(scolded.drives, 'pat', scolded.ledger, tomorrow);
    expect(nextDay.drives.bond).toBeCloseTo(0.29, 9);
    expect(nextDay.ledger).toEqual({ day: dayOf(tomorrow), gained: expect.closeTo(0.02, 9) });
  });

  it('움직이면 기운이 줄고 집에서 쉬면 차며, 배부름은 분당 0.06씩 0.2까지 준다', () => {
    const drives: PetDrives = { energy: 0.5, satiety: 0.5, mood: 0.6, bond: 0.4 };
    expect(stepDrives(drives, 10, 'move').energy).toBeCloseTo(0.46);
    expect(stepDrives(drives, 10, 'rest').energy).toBeCloseTo(0.6);
    expect(stepDrives(drives, 10, 'still').energy).toBe(0.5);
    expect(stepDrives(drives, 60, 'still').satiety).toBeCloseTo(0.44);
    expect(stepDrives(drives, 3600, 'still').satiety).toBe(0.2);
    expect(stepDrives(drives, 3600, 'move').energy).toBe(0);
    expect(stepDrives(drives, 0, 'move')).toBe(drives);
    expect(stepDrives(drives, Number.NaN, 'move')).toBe(drives);
    expect(stepDrives({ ...drives, mood: 1 }, 600, 'still').mood).toBeCloseTo(0.9);
    expect(stepDrives({ ...drives, mood: 0 }, 3600 * 24, 'still').mood).toBeCloseTo(0.6);
    expect(driveActivity('come', true)).toBe('move');
    expect(driveActivity('rest', true)).toBe('move');
    expect(driveActivity('rest', false)).toBe('rest');
    expect(driveActivity('sit', false)).toBe('still');
  });

  it('다시 접속하면 지난 시간만큼 기운이 차고 배부름이 줄며, 일주일까지만 센다', () => {
    const drives: PetDrives = { energy: 0.1, satiety: 0.9, mood: 0.3, bond: 0.4 };
    const minute = catchUpDrives(drives, 60);
    expect(minute.energy).toBeCloseTo(0.7);
    expect(minute.satiety).toBeCloseTo(0.84);
    expect(minute.bond).toBe(0.4);
    const day = catchUpDrives(drives, 24 * 3600);
    expect(day).toEqual({ energy: 1, satiety: 0.2, mood: 0.6, bond: 0.4 });
    expect(catchUpDrives(drives, 365 * 24 * 3600)).toEqual(day);
    expect(catchUpDrives(drives, -500)).toBe(drives);
    expect(catchUpDrives(drives, Number.NaN)).toBe(drives);
    expect(catchUpDrives({ ...drives, satiety: 0.1 }, 3600).satiety).toBe(0.1);
  });

  it('저장된 욕구는 값마다 검사하고 없으면 기본값을 쓴다', () => {
    expect(readDrives({})).toEqual(DEFAULT_DRIVES);
    expect(readDrives(null)).toEqual(DEFAULT_DRIVES);
    expect(readDrives({ energy: 0.3, satiety: 2, mood: 'x', bond: -1 })).toEqual({
      energy: 0.3,
      satiety: 1,
      mood: DEFAULT_DRIVES.mood,
      bond: 0,
    });
    expect(readDrives({ energy: Number.NaN })).toEqual(DEFAULT_DRIVES);
  });
});
