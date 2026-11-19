import { Color } from 'three';
import { describe, expect, it } from 'vitest';

import { readingOf, type Birth } from '../engine';
import { profileOfReading } from '../profile';
import { BRIDGE_FOOT, HOME_HALF, LANDINGS } from '../scene/estate/coast';
import { estateOf } from '../scene/estate/layout';
import { Builder } from '../scene/build';
import { estateGround } from '../scene/estate/ground';
import { EstateSite } from '../scene/estate/site';
import { nearestOn, pointAlong } from '../scene/estate/lines';
import { estateHomeOf, landingsOf, lawnOf, onSquare, SquareCoast } from '../scene/estateHome';
import { ISLANDS, shoreAt } from '../scene/terrain';
import { plotsOf } from '../village';
import { PEOPLE } from './people';

/** The four people's births and one without an hour. */
const BIRTHS: readonly Birth[] = [...PEOPLE.map(({ birth }) => birth), { calendar: 'solar', year: 1995, month: 9, day: 3, leapMonth: false, time: null, gender: 'female' }];
const homes = BIRTHS.map((birth) => estateHomeOf(readingOf(birth)));
/** What is meant to stand in the water or at its edge: the jetty, a boat by it, ducks, the reeds of the shallows. */
const wet = (id: string, motif?: string) => id === 'shore:jetty' || id.startsWith('shore:reeds') || motif === 'boat' || motif === 'ducks';

describe('미니홈피 주인의 섬: 호수가 아는 둥근 네모 위의 영지', () => {
  it('섬은 영지의 크기다: 이웃 섬 네 개를 늘어놓은 만큼 넓고, 모서리는 영지의 물가만큼 둥글다', () => {
    expect(ISLANDS.home.half).toBe(HOME_HALF);
    expect(ISLANDS.home.corner).toBeLessThan(ISLANDS.home.half);
    // 대각선의 물가는 둥근 영지(초타원)의 물가와 반 미터 안쪽으로 만난다.
    expect(Math.abs(shoreAt(ISLANDS.home, Math.PI / 4) - HOME_HALF * 2 ** (0.5 - 1 / 2.5))).toBeLessThan(0.5);
  });

  it('물가 선은 호수가 아는 둥근 네모를 따라 반 미터 안쪽으로만 구불거린다', () => {
    for (const estate of homes) {
      const coast = estate.coast as SquareCoast;
      expect(coast).toBeInstanceOf(SquareCoast);
      for (let step = 0; step < 72; step++) {
        const bearing = (step / 72) * Math.PI * 2;
        const radius = coast.radius(bearing);
        expect(Math.abs(radius - shoreAt(ISLANDS.home, bearing))).toBeLessThan(0.5);
        // 그 선의 안쪽은 땅, 바깥은 물이다.
        const [cos, sin] = [Math.cos(bearing), Math.sin(bearing)];
        expect(coast.inside(cos * (radius - 1), sin * (radius - 1))).toBeGreaterThan(0.5);
        expect(coast.inside(cos * (radius + 1), sin * (radius + 1))).toBeLessThan(-0.5);
      }
      expect(coast.hull).toBe(ISLANDS.home);
      expect(coast.farthest).toBeLessThan(shoreAt(ISLANDS.home, Math.PI / 4) + 0.5);
      // 땅은 물가 둘레의 비탈이 호수 바닥에 닿는 데까지 지어진다: 모래톱이 가장 멀다.
      expect(coast.groundReach).toBeGreaterThan(coast.farthest + 1.5);
    }
  });

  it('다리가 닿는 여덟 자리는 마을이 다리를 놓는 자리다', () => {
    for (const estate of homes) {
      expect(estate.landings).toHaveLength(8);
      for (const landing of estate.landings) {
        expect(landing.bearing).toBeCloseTo(LANDINGS[landing.index]!, 9);
        expect(Math.abs(landing.radius - shoreAt(ISLANDS.home, landing.bearing))).toBeLessThan(0.5);
        expect(Math.hypot(...landing.foot)).toBeCloseTo(landing.radius - BRIDGE_FOOT, 9);
      }
    }
  });

  it('서 있는 것은 모두 단단한 땅 위에 있고, 물에 둘 것만 물가에 있다', () => {
    for (const estate of homes) {
      for (const { id, motif, at, reach } of estate.placements) {
        const inside = estate.coast.inside(at[0], at[1]);
        if (wet(id, motif)) {
          expect(inside).toBeLessThan(1);
          continue;
        }
        if (reach > 0) expect(inside).toBeGreaterThan(0.85);
        else expect(inside).toBeGreaterThan(-0.3);
      }
    }
  });

  it('선착장은 물가에서 물 위로 뻗고, 개울은 둑을 지나 호수로 나간다', () => {
    for (const estate of homes) {
      const { jetty, coast, stream } = estate;
      expect(coast.inside(jetty.x, jetty.z)).toBeGreaterThan(0.3);
      expect(coast.inside(jetty.x, jetty.z)).toBeLessThan(1.2);
      const end = [jetty.x + Math.cos(jetty.bearing) * jetty.length, jetty.z + Math.sin(jetty.bearing) * jetty.length] as const;
      expect(coast.inside(end[0], end[1])).toBeLessThan(-3);
      expect(coast.inside(stream.mouth[0], stream.mouth[1])).toBeLessThan(-1);
      expect(coast.inside(stream.spring[0], stream.spring[1])).toBeGreaterThan(5);
    }
  });

  it('다리로 가는 길은 그 다리의 발치에서 끝난다', () => {
    for (const estate of homes) {
      for (const path of estate.paths) {
        for (const end of [path.line[0]!, path.line[path.line.length - 1]!]) {
          // 물가 가까이 끝나는 길은 다리가 닿는 자리나 선착장에서 끝난다.
          if (estate.coast.inside(end[0], end[1]) > 2) continue;
          const atFoot = estate.landings.some((landing) => Math.hypot(landing.foot[0] - end[0], landing.foot[1] - end[1]) < 1e-9);
          const atJetty = Math.hypot(estate.jetty.x - end[0], estate.jetty.z - end[1]) < 1e-9;
          expect(atFoot || atJetty).toBe(true);
        }
      }
      // 네 변의 다리에는 언제나 길이 있다.
      for (const index of [0, 2, 4, 6]) {
        const foot = estate.landings[index]!.foot;
        expect(estate.paths.some((path) => [path.line[0]!, path.line[path.line.length - 1]!].some((end) => Math.hypot(end[0] - foot[0], end[1] - foot[1]) < 1e-9))).toBe(true);
      }
    }
  });

  it('길가에 등불이 이어진다: 길에서 비켜, 서로 떨어져, 물가에서 안쪽에', () => {
    for (const estate of homes) {
      const lamps = estate.placements.filter((placement) => placement.kind === 'lamp');
      expect(lamps.length).toBeGreaterThanOrEqual(12);
      for (const [index, lamp] of lamps.entries()) {
        const [x, z] = lamp.at;
        expect(estate.coast.inside(x, z)).toBeGreaterThan(1);
        for (const other of lamps.slice(index + 1)) expect(Math.hypot(other.at[0] - x, other.at[1] - z)).toBeGreaterThan(1.5);
        if (!lamp.id.includes(':more:')) continue;
        for (const path of estate.paths) expect(nearestOn(path.line, x, z).distance).toBeGreaterThan(path.width / 2);
        expect(nearestOn(estate.stream.line, x, z).distance).toBeGreaterThan(estate.stream.width[1] / 2);
      }
    }
  });

  it('같은 생일은 언제나 같은 영지가 된다', () => {
    const reading = readingOf(BIRTHS[0]!);
    const [a, b] = [estateHomeOf(reading), estateHomeOf(reading)];
    expect(a.placements.map(({ id, at }) => ({ id, at }))).toEqual(b.placements.map(({ id, at }) => ({ id, at })));
    expect(a.stream.line).toEqual(b.stream.line);
  });

  it('영지의 자리는 그대로이고, 물가에 기대어 놓인 것만 옮겨진다', () => {
    const reading = readingOf(BIRTHS[1]!);
    const laid = estateOf(reading, { bridges: [1, 3, 5, 7] });
    const moved = onSquare(laid);
    expect(moved.house).toEqual(laid.house);
    expect(moved.guardian).toEqual(laid.guardian);
    const before = new Map(laid.placements.map((placement) => [placement.id, placement.at]));
    const kept = moved.placements.filter((placement) => before.get(placement.id) === placement.at);
    // 집, 마당, 뜰, 과수원의 것은 제자리에 있다.
    for (const id of ['day:house', 'day:guardian', 'day:emblem']) expect(kept.some((placement) => placement.id === id)).toBe(true);
    expect(kept.length).toBeGreaterThan(laid.placements.length * 0.7);
    // 개울의 앞부분은 그대로 흐른다.
    expect(moved.stream.line.slice(0, laid.stream.line.length)).toEqual(laid.stream.line);
    expect(pointAlong(moved.stream.line, 0).at).toEqual(laid.stream.spring);
  });
});

describe('영지의 잔디밭', () => {
  const estate = homes[0]!;
  const { house } = profileOfReading(readingOf(BIRTHS[0]!));
  const paint = lawnOf(estate, house.style);

  it('바닥을 바꾸면 잔디의 재질과 색만 달라지고 지형의 꼭짓점은 유지된다', () => {
    const site = new EstateSite(estate);
    const samples = (['default', 'snow', 'desert', 'moss'] as const).map((terrain) => {
      const b = new Builder(estate.seed);
      const choice = lawnOf(estate, house.style, terrain);
      estateGround(b, site, choice, { index: 1, of: 4 });
      const meshes = b.finish().meshes;
      const turf = meshes.find(({ look }) => look && 'finish' in look && look.finish.surface === (choice.surface ?? 'ground'))!;
      return { at: turf.geometry.getAttribute('position').array, tint: turf.geometry.getAttribute('color').array };
    });
    for (const sample of samples.slice(1)) {
      expect(sample.at.length).toBe(samples[0]!.at.length);
      expect(sample.at.every((n, i) => n === samples[0]!.at[i])).toBe(true);
      expect(sample.tint.some((n, i) => Math.abs(n - samples[0]!.tint[i]!) > 0.02)).toBe(true);
    }
  });

  it('가을이나 겨울의 풀빛도 멀리서 맨땅으로 보이지 않게 집의 잔디만큼 푸르다', () => {
    const season = estate.plan.season;
    const green = (hex: string) => {
      const color = new Color(hex);
      return color.g - Math.max(color.r, color.b);
    };
    const own = green(season.grass[0]!);
    expect(green(paint.lawn[0])).toBeGreaterThanOrEqual(own - 1e-9);
    if (season.key === 'autumn' || season.key === 'winter') expect(green(paint.lawn[0])).toBeGreaterThan(own);
  });
});

describe('다리가 닿는 자리', () => {
  it('이웃의 자리를 영지의 여덟 자리로 옮긴다', () => {
    const plots = plotsOf(Array.from({ length: 8 }, (_, index) => ({ id: `n${index}`, element: 'earth' as const })));
    expect(landingsOf(plots)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(landingsOf([{ x: 0, z: 0 }, ...plots.slice(0, 2)])).toEqual([0, 2]);
    expect(landingsOf([])).toEqual([]);
  });
});
