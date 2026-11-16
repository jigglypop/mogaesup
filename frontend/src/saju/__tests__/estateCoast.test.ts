import { describe, expect, it } from 'vitest';

import { BRIDGE_FOOT, Coast, ESTATE_HALF, LANDINGS } from '../scene/estate/coast';
import { ISLANDS, shoreAt } from '../scene/terrain';

const TAU = Math.PI * 2;
const wrap = (angle: number) => angle - TAU * Math.floor((angle + Math.PI) / TAU);
const SEEDS = [1, 77, 4242, 98765, 524287];

describe('the estate coast', () => {
  it('is about four neighbours across', () => {
    for (const seed of SEEDS) {
      const coast = new Coast(seed);
      expect(coast.hull.half / ISLANDS.neighbour.half).toBeGreaterThan(3.9);
      expect(coast.hull.half / ISLANDS.neighbour.half).toBeLessThan(4.9);
      expect(coast.nearest).toBeGreaterThan(ESTATE_HALF - 5);
      expect(coast.farthest).toBeLessThan(ESTATE_HALF * 1.1 + 4);
    }
  });

  it('is the same for the same seed, and wanders its own way for another', () => {
    const a = new Coast(4242);
    const b = new Coast(4242);
    const c = new Coast(4243);
    const bearings = Array.from({ length: 64 }, (_, index) => -Math.PI + (index / 64) * TAU);
    expect(bearings.map((bearing) => a.radius(bearing))).toEqual(bearings.map((bearing) => b.radius(bearing)));
    expect(Math.max(...bearings.map((bearing) => Math.abs(a.radius(bearing) - c.radius(bearing))))).toBeGreaterThan(0.2);
  });

  it('keeps its coves, headlands and beach between the landings, so every bridge comes to a plain bank', () => {
    for (const seed of SEEDS) {
      const coast = new Coast(seed);
      for (const feature of coast.features) for (const landing of LANDINGS) expect(Math.abs(wrap(feature.bearing - landing))).toBeGreaterThan(feature.half);
      for (const landing of coast.landings) {
        expect(coast.share(landing.bearing, 'beach') + coast.share(landing.bearing, 'cove') + coast.share(landing.bearing, 'point')).toBe(0);
        // The bridge's foot is on the bank, its way out over the water.
        expect(coast.inside(landing.foot[0], landing.foot[1])).toBeCloseTo(BRIDGE_FOOT, 1);
      }
    }
  });

  it('has one of each: a harbour, a mouth, a beach, and headlands and inlets', () => {
    const coast = new Coast(77);
    const kinds = coast.features.map((feature) => feature.kind);
    for (const kind of ['harbour', 'mouth', 'beach'] as const) expect(kinds.filter((item) => item === kind)).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'point').length).toBeGreaterThanOrEqual(2);
    expect(kinds.filter((kind) => kind === 'cove').length).toBeGreaterThanOrEqual(2);
    // A cove runs in from the round and a headland out of it.
    const base = (bearing: number) => ESTATE_HALF / (Math.abs(Math.cos(bearing)) ** 2.5 + Math.abs(Math.sin(bearing)) ** 2.5) ** (1 / 2.5);
    const harbour = coast.feature('harbour');
    const point = coast.feature('point');
    expect(coast.radius(harbour.bearing) - base(harbour.bearing)).toBeLessThan(-1.2);
    expect(coast.radius(point.bearing) - base(point.bearing)).toBeGreaterThan(0.6);
  });

  it('measures across the shore: zero on the waterline, positive inland, negative out in the lake', () => {
    const coast = new Coast(98765);
    for (let index = 0; index < 48; index++) {
      const bearing = -Math.PI + (index / 48) * TAU;
      const [x, z] = coast.at(bearing);
      expect(Math.abs(coast.inside(x, z))).toBeLessThan(0.02);
      const [ix, iz] = coast.at(bearing, 2);
      const [ox, oz] = coast.at(bearing, -2);
      expect(coast.inside(ix, iz)).toBeGreaterThan(0.8);
      expect(coast.inside(ox, oz)).toBeLessThan(-0.8);
    }
    expect(coast.inside(0, 0)).toBeGreaterThan(ESTATE_HALF - 5);
  });

  it('banks a beach more gently than a rock', () => {
    const coast = new Coast(1);
    const beach = coast.feature('beach');
    const rocky = coast.bank(0);
    const sandy = coast.bank(beach.bearing);
    expect(sandy.lawn).toBeGreaterThan(rocky.lawn * 3);
    expect(sandy.bed).toBeGreaterThan(rocky.bed * 3);
    expect(coast.groundReach).toBeGreaterThan(coast.farthest + rocky.bed);
  });

  it('stands its jetty in the harbour, from the bank out over the water', () => {
    for (const seed of SEEDS) {
      const coast = new Coast(seed);
      const { jetty } = coast;
      expect(coast.share(jetty.bearing, 'harbour')).toBeGreaterThan(0.9);
      expect(coast.inside(jetty.x, jetty.z)).toBeGreaterThan(0.3);
      const end: [number, number] = [jetty.x + Math.cos(jetty.bearing) * jetty.length, jetty.z + Math.sin(jetty.bearing) * jetty.length];
      expect(coast.inside(end[0], end[1])).toBeLessThan(-3);
    }
  });

  it('gives a rounded square close to its straight sides for what still reckons an island as one', () => {
    for (const seed of SEEDS) {
      const coast = new Coast(seed);
      for (const bearing of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) expect(Math.abs(shoreAt(coast.hull, bearing) - coast.radius(bearing))).toBeLessThan(2.2);
      expect(coast.hull.reach).toBeGreaterThan(coast.farthest);
    }
  });

  it('hands a shader its waterline every quarter degree', () => {
    const coast = new Coast(77);
    const table = coast.table();
    expect(table).toHaveLength(1440);
    expect(table[0]).toBeCloseTo(coast.radius(-Math.PI), 4);
    expect(table[720]).toBeCloseTo(coast.radius(0), 4);
  });
});
