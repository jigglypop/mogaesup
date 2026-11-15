import { describe, expect, it } from 'vitest';

import { readingOf, type Birth } from '../engine';
import { islandPlanOf } from '../mulsang';
import { estateOf, partAt, placementsOf, type Estate, type Placement } from '../scene/estate/layout';
import { nearestOn } from '../scene/estate/lines';
import { ISLANDS } from '../scene/terrain';
import { PEOPLE } from './people';

/** The four people's births and one without an hour. */
const BIRTHS: readonly { id: string; birth: Birth }[] = [
  ...PEOPLE.map(({ id, birth }) => ({ id, birth })),
  { id: 'haneul', birth: { calendar: 'solar', year: 1995, month: 9, day: 3, leapMonth: false, time: null, gender: 'female' } },
  { id: 'seoyun', birth: { calendar: 'solar', year: 2001, month: 4, day: 9, leapMonth: false, time: '14:40', gender: 'female' } },
];
const estates = BIRTHS.map(({ id, birth }) => ({ id, estate: estateOf(readingOf(birth)) }));

/** What keeps its ground to itself (everything placed with a reach), and is drawn on firm ground. */
const standing = (estate: Estate) => estate.placements.filter((placement) => placement.reach > 0);

describe('an estate', () => {
  it('is laid out the same for the same birth', () => {
    for (const { birth } of BIRTHS) {
      const [a, b] = [estateOf(readingOf(birth)), estateOf(readingOf(birth))];
      expect(a.placements.map(({ id, at, facing, scale, seed }) => ({ id, at, facing, scale, seed }))).toEqual(b.placements.map(({ id, at, facing, scale, seed }) => ({ id, at, facing, scale, seed })));
      expect(a.paths.map((path) => path.line)).toEqual(b.paths.map((path) => path.line));
    }
  });

  it('is laid out from the reading’s own plan', () => {
    for (const { birth } of BIRTHS) {
      const reading = readingOf(birth);
      expect(estateOf(reading).plan).toBe(islandPlanOf(reading));
    }
  });

  it('is about four times as wide and deep as a neighbour’s island, sixteen times its ground', () => {
    for (const { estate } of estates) {
      const across = estate.coast.hull.half / ISLANDS.neighbour.half;
      expect(across).toBeGreaterThan(3.9);
      expect(across).toBeLessThan(4.9);
    }
  });

  it('stands everything on firm ground, clear of the bank', () => {
    for (const { id, estate } of estates) {
      for (const placement of standing(estate)) {
        expect(estate.coast.inside(placement.at[0], placement.at[1]), `${id} ${placement.id}`).toBeGreaterThan(placement.reach * 0.5 + 0.5);
      }
    }
  });

  it('keeps every standing thing’s ground to itself', () => {
    for (const { id, estate } of estates) {
      const things = standing(estate).filter((placement) => placement.kind !== 'house');
      for (let a = 0; a < things.length; a++) {
        for (let b = a + 1; b < things.length; b++) {
          const one = things[a]!;
          const other = things[b]!;
          const apart = Math.hypot(one.at[0] - other.at[0], one.at[1] - other.at[1]);
          expect(apart + 1e-6, `${id} ${one.id} ${other.id}`).toBeGreaterThanOrEqual(one.reach + other.reach);
        }
      }
    }
  });

  it('keeps the paths clear, the guardian and the yard’s things included', () => {
    for (const { id, estate } of estates) {
      for (const placement of standing(estate)) {
        if (placement.kind === 'house') continue;
        for (const path of estate.paths) {
          const { distance } = nearestOn(path.line, placement.at[0], placement.at[1]);
          expect(distance, `${id} ${placement.id} on ${path.id}`).toBeGreaterThan(placement.reach + path.width / 2 - 0.05);
        }
      }
    }
  });

  it('gives the guardian room for what its 신살 gave it, at the door’s right', () => {
    for (const { estate } of estates) {
      const { guardian, house } = estate;
      expect(guardian.at[0]).toBeGreaterThan(house.door[0]);
      expect(guardian.at[1]).toBeGreaterThan(house.at[1] + house.footprint.front);
      for (const placement of standing(estate)) {
        if (placement.kind === 'guardian' || placement.kind === 'house') continue;
        expect(Math.hypot(placement.at[0] - guardian.at[0], placement.at[1] - guardian.at[1])).toBeGreaterThanOrEqual(guardian.reach + placement.reach - 1e-6);
      }
    }
  });

  it('puts every one of the plan’s motifs somewhere on it', () => {
    for (const { id, estate } of estates) {
      const placed = new Set(placementsOf(estate, 'motif').map((placement) => placement.motif));
      for (const motif of estate.plan.motifs) {
        if (motif.place === 'corner') {
          expect(placementsOf(estate, 'fruitTree').length, `${id} orchard`).toBeGreaterThanOrEqual(6);
          continue;
        }
        expect(placed.has(motif.motif), `${id} ${motif.pillar} ${motif.motif}`).toBe(true);
      }
    }
  });

  it('lays the pillars out from the back to the front: 년 behind the house, 월 in the garden, 일 at the heart, 시 in front', () => {
    for (const { id, estate } of estates) {
      const houseZ = estate.house.at[1];
      for (const placement of placementsOf(estate, 'motif')) {
        if (placement.by === 'house') {
          expect(placement.at).toEqual(estate.house.at);
          continue;
        }
        if (placement.part === 'year' && placement.motif !== 'boat' && !['pearlShell', 'goldSand', 'sandbank', 'crystals'].includes(placement.motif!)) expect(placement.at[1], `${id} ${placement.id}`).toBeLessThan(houseZ - 5);
        // A brook is the estate's own stream, dressed as the pillar's: it runs where the stream runs.
        if (placement.part === 'month' && placement.motif !== 'brook') expect(partAt(estate, placement.at[0], placement.at[1]), `${id} ${placement.id}`).toBe('month');
        if (placement.part === 'hour' && placement.motif !== 'ducks') expect(placement.at[1], `${id} ${placement.id}`).toBeGreaterThan(houseZ + 6);
      }
      for (const tree of placementsOf(estate, 'fruitTree')) expect(partAt(estate, tree.at[0], tree.at[1])).toBe('hour');
      expect(partAt(estate, estate.house.at[0], estate.house.at[1])).toBe('day');
    }
  });

  it('plants the hour’s orchard in its season, and leaves a meadow of wildflowers where there is no hour', () => {
    for (const { id, estate } of estates) {
      const corner = estate.plan.motifs.find((motif) => motif.place === 'corner');
      const orchard = placementsOf(estate, 'fruitTree');
      if (corner) {
        expect(orchard.length, id).toBeGreaterThanOrEqual(6);
        for (const tree of orchard) expect(tree.state).toBe(corner.state);
      } else {
        expect(orchard).toHaveLength(0);
        expect(estate.placements.some((placement) => placement.id === 'hour:wildflowers')).toBe(true);
      }
      expect(estate.meadow.nests).toHaveLength(3);
    }
  });

  it('runs a path from the house to every side’s landing, and to a corner’s only where a bridge lands', () => {
    for (const { estate } of estates) {
      for (const index of [0, 2, 4, 6]) {
        const landing = estate.landings[index]!;
        expect(Math.min(...estate.paths.map((path) => nearestOn(path.line, landing.foot[0], landing.foot[1]).distance))).toBeLessThan(0.3);
      }
      for (const index of [1, 3, 5, 7]) {
        const landing = estate.landings[index]!;
        expect(Math.min(...estate.paths.map((path) => nearestOn(path.line, landing.foot[0], landing.foot[1]).distance))).toBeGreaterThan(1);
      }
    }
    const { birth } = BIRTHS[0]!;
    const bridged = estateOf(readingOf(birth), { bridges: [1, 3, 5, 7] });
    for (const index of [1, 3, 5, 7]) {
      const landing = bridged.landings[index]!;
      expect(Math.min(...bridged.paths.map((path) => nearestOn(path.line, landing.foot[0], landing.foot[1]).distance))).toBeLessThan(0.3);
    }
  });

  it('keeps the way up every landing’s bank clear for a bridge', () => {
    for (const { estate } of estates) {
      for (const placement of standing(estate)) {
        for (const landing of estate.landings) {
          const cos = Math.cos(landing.bearing);
          const sin = Math.sin(landing.bearing);
          const out = placement.at[0] * cos + placement.at[1] * sin - (landing.radius - 3.4);
          const across = Math.abs(placement.at[1] * cos - placement.at[0] * sin);
          expect(out < -placement.reach || across >= 1.6 + placement.reach - 1e-6, placement.id).toBe(true);
        }
      }
    }
  });

  it('runs its stream from the spring to the sea, a footbridge where the east path crosses it', () => {
    for (const { estate } of estates) {
      const { stream, coast } = estate;
      expect(coast.inside(stream.spring[0], stream.spring[1])).toBeGreaterThan(5);
      expect(coast.inside(stream.mouth[0], stream.mouth[1])).toBeLessThan(0);
      expect(coast.share(Math.atan2(stream.mouth[1], stream.mouth[0]), 'mouth')).toBeGreaterThan(0.5);
      expect(placementsOf(estate, 'footbridge').some((bridge) => bridge.id.endsWith(':east'))).toBe(true);
    }
  });

  it('keeps places open for what the owner sets out later', () => {
    for (const { estate } of estates) {
      expect(estate.decor.length).toBeGreaterThanOrEqual(4);
      for (const slot of estate.decor) {
        for (const placement of standing(estate)) expect(Math.hypot(slot.at[0] - placement.at[0], slot.at[1] - placement.at[1])).toBeGreaterThanOrEqual(slot.reach + placement.reach - 1e-6);
        for (const path of estate.paths) expect(nearestOn(path.line, slot.at[0], slot.at[1]).distance).toBeGreaterThan(slot.reach + path.width / 2);
      }
    }
  });

  it('dresses the house with the 일주’s motifs and lets the houses builder draw them', () => {
    for (const { estate } of estates) {
      const onHouse = estate.placements.filter((placement: Placement) => placement.by === 'house' && placement.kind === 'motif');
      for (const motif of estate.plan.pillars.day.motifs) expect(onHouse.some((placement) => placement.motif === motif.motif && placement.on === motif.place)).toBe(true);
    }
  });

  it('is laid out in a few milliseconds', () => {
    const reading = readingOf(BIRTHS[0]!.birth);
    estateOf(reading);
    const times: number[] = [];
    for (let round = 0; round < 5; round++) {
      const began = performance.now();
      estateOf(reading);
      times.push(performance.now() - began);
    }
    expect(times.sort((a, b) => a - b)[2]).toBeLessThan(40);
  });
});
