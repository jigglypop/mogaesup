import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Material } from 'three';

import { ELEMENTS } from '../elements';
import type { YardSymbol } from '../profile';
import { Builder, type Build } from '../scene/build';
import { buildHome, buildHouse, buildLot, EMBLEM_AT, GUARDIAN_AT, KEEPSAKE_AT, type IslandKind } from '../scene/homes';
import { WATER_LEVEL } from '../scene/mood';
import { fbm, hash, rng, tileNoise, worley } from '../scene/noise';
import { sprigGeometry } from '../scene/sprigs';
import { surfaceMaps } from '../scene/surfaces';
import { ISLANDS, shoreAt, Site } from '../scene/terrain';

const SYMBOLS: YardSymbol[] = ['tree', 'trellis', 'sun', 'candle', 'mountain', 'field', 'anvil', 'gem', 'lighthouse', 'rain'];
const KINDS: IslandKind[] = ['home', 'neighbour'];

/** Triangles a build hands the graphics card: its meshes', and each scattered copy's. */
function trianglesOf(build: Build): number {
  const meshes = build.meshes.reduce((sum, { geometry }) => sum + geometry.index!.count / 3, 0);
  return meshes + build.sprigs.reduce((sum, { kind, count }) => sum + count * (sprigGeometry(kind).index?.count ?? sprigGeometry(kind).getAttribute('position').count) / 3, 0);
}

/** Every corner of a build's meshes but its ground's, and where each scattered thing is put. */
function pointsOf(build: Build): { built: [number, number, number][]; scattered: [number, number, number][] } {
  const ground = new Set([surfaceMaps('ground').map, surfaceMaps('rock').map]);
  const built: [number, number, number][] = [];
  for (const { geometry, material } of build.meshes) {
    if (ground.has((material as Material & { map?: unknown }).map as never)) continue;
    const position = geometry.getAttribute('position');
    for (let index = 0; index < position.count; index++) built.push([position.getX(index), position.getY(index), position.getZ(index)]);
  }
  const scattered = build.sprigs.flatMap(({ count, matrices }) => Array.from({ length: count }, (_, index): [number, number, number] => [matrices[index * 16 + 12]!, matrices[index * 16 + 13]!, matrices[index * 16 + 14]!]));
  return { built, scattered };
}

/** The lit panes of a build (windows, paper doors, transoms): a house's every opening. */
const panesOf = (build: Build) => build.meshes.filter(({ material }) => !!(material as Material & { emissiveMap?: unknown }).emissiveMap).reduce((sum, { geometry }) => sum + geometry.index!.count, 0);

beforeAll(() => {
  // A lit window's picture is drawn on a 2D canvas, which jsdom does not have: the pane is then left plain.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

describe('마을의 난수', () => {
  it('같은 자리에서는 늘 같은 값이고 0과 1 사이다', () => {
    for (let index = 0; index < 200; index++) {
      const value = hash(index * 7, index * 13, 3);
      expect(value).toBe(hash(index * 7, index * 13, 3));
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(hash(1, 2, 3)).not.toBe(hash(2, 1, 3));
  });

  it('타일의 가장자리에서 이어진다', () => {
    for (const y of [0.2, 3.7]) {
      expect(tileNoise(0.3, y, 8)).toBeCloseTo(tileNoise(8.3, y, 8), 10);
      expect(tileNoise(y, 0.3, 8)).toBeCloseTo(tileNoise(y, 8.3, 8), 10);
    }
    expect(fbm(0, 0.4, 4, 3)).toBeCloseTo(fbm(1, 0.4, 4, 3), 10);
    expect(worley(0.02, 0.5, 5).near).toBeCloseTo(worley(1.02, 0.5, 5).near, 10);
  });

  it('씨앗이 같으면 같은 수열을 낸다', () => {
    const [a, b, other] = [rng(23), rng(23), rng(24)];
    const first = Array.from({ length: 20 }, a);
    expect(Array.from({ length: 20 }, b)).toEqual(first);
    expect(Array.from({ length: 20 }, other)).not.toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe('섬의 땅', () => {
  const site = new Site(23, [{ x: -2.75, z: 2.95, rx: 1.6, rz: 1.25 }]);

  it('가운데는 잔디밭이고 바깥은 호수 밑이다', () => {
    expect(site.height(0, 0)).toBe(0);
    expect(site.height(2, -3)).toBe(0);
    expect(site.height(9, 0)).toBeLessThan(WATER_LEVEL - 0.8);
    expect(site.height(7, 7)).toBeLessThan(WATER_LEVEL - 0.8);
  });

  it('물가는 섬 가운데에서 다섯에서 여섯 미터 남짓 사이에 있다', () => {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      expect(site.height(dx * 4.9, dz * 4.9)).toBeGreaterThan(WATER_LEVEL);
      expect(site.height(dx * 6.2, dz * 6.2)).toBeLessThan(WATER_LEVEL);
    }
  });

  it('연못은 호수의 물이 드는 깊이까지 파인다', () => {
    expect(site.height(-2.75, 2.95)).toBeLessThan(WATER_LEVEL - 0.4);
    expect(site.pond(-2.75, 2.95)).toBeCloseTo(1);
  });

  it('잔디는 평지에만, 연못과 비워 둔 자리와 마당을 피해 자란다', () => {
    const yard = new Site(23, site.ponds).keep(1, 1, 0.5).bare(-3, -3, 1);
    expect(yard.open(0, -1)).toBe(true);
    expect(yard.open(1.2, 0.9)).toBe(false);
    expect(yard.open(-2.75, 2.95)).toBe(false);
    expect(yard.open(-3, -3)).toBe(false);
    expect(yard.open(5.4, 0)).toBe(false);
    expect(yard.bareness(-3, -3)).toBe(1);
    expect(yard.bareness(2, 2)).toBe(0);
  });
});

describe('짓는 이', () => {
  it('같은 재료의 모양은 한 덩이로 쌓고, 재료가 다르면 덩이를 나눈다', () => {
    const b = new Builder(1);
    b.box([1, 1, 1], [0, 0, 0], '#ffffff').box([2, 1, 1], [3, 0, 0], '#ff0000').box([1, 1, 1], [0, 3, 0], '#ffffff', { surface: 'brick' });
    const { meshes } = b.finish();
    expect(meshes).toHaveLength(2);
    const [plain, brick] = meshes;
    expect(plain!.geometry.getAttribute('position').count).toBe(48);
    expect(plain!.geometry.index!.count).toBe(72);
    expect(brick!.geometry.getAttribute('position').count).toBe(24);
    expect(plain!.cast).toBe(true);
  });

  it('무리 안의 모양은 무리와 함께 옮겨지고 돌려진다', () => {
    const b = new Builder(1);
    b.group([10, 0, 0], () => b.box([2, 2, 2], [0, 1, 0], '#ffffff'), Math.PI / 2, 2);
    const geometry = b.finish().meshes[0]!.geometry;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.min.x).toBeCloseTo(8);
    expect(box.max.x).toBeCloseTo(12);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.y).toBeCloseTo(4);
  });

  it('빛나거나 비치는 것은 그림자를 드리우지 않는다', () => {
    const b = new Builder(1);
    b.box([1, 1, 1], [0, 0, 0], '#ffffff', { glow: '#ffcc88', power: 3 }).box([1, 1, 1], [0, 0, 0], '#ffffff', { opacity: 0.5 }).box([1, 1, 1], [0, 0, 0], '#ffffff', { shadowless: true });
    expect(b.finish().meshes.map((mesh) => mesh.cast)).toEqual([false, false, false]);
  });

  it('흩뿌린 것, 등불, 움직이는 것의 자리도 무리를 따른다', () => {
    const b = new Builder(1);
    b.group([1, 2, 3], () => {
      b.sprig('leaf', [0, 0, 0], 0.5, '#00ff00');
      b.lamp([0, 1, 0], '#ffcc88', 2);
      b.life({ kind: 'smoke', at: [0, 2, 0] });
    });
    const { sprigs, lamps, lives } = b.finish();
    expect(sprigs).toHaveLength(1);
    expect(sprigs[0]!.count).toBe(1);
    expect(Array.from(sprigs[0]!.matrices.slice(12, 15))).toEqual([1, 2, 3]);
    expect(lamps[0]!.at).toEqual([1, 3, 3]);
    expect(lives[0]!.at).toEqual([1, 4, 3]);
  });
});

describe('다섯 집', () => {
  it.each(ELEMENTS)('%s의 집이 지어진다: 굴뚝 연기와 등불, 나무가 있다', (style) => {
    const build = buildHome({ style, accent: null, symbol: 'tree' });
    expect(build.meshes.length).toBeGreaterThan(4);
    expect(build.meshes.every((mesh) => mesh.geometry.index!.count > 0)).toBe(true);
    const kinds = new Map(build.sprigs.map((sprigs) => [sprigs.kind, sprigs.count]));
    expect(kinds.get('leaf')).toBeGreaterThan(500);
    expect(build.lamps.length).toBeGreaterThanOrEqual(3);
    expect(build.lives.some((life) => life.kind === 'smoke')).toBe(true);
    // Every number that reaches the graphics card is a number.
    for (const { geometry } of build.meshes) expect(Number.isFinite((geometry.getAttribute('position').array as Float32Array).reduce((sum, value) => sum + value, 0))).toBe(true);
    for (const { matrices } of build.sprigs) expect(Number.isFinite(matrices.reduce((sum, value) => sum + value, 0))).toBe(true);
  }, 30_000);

  it('같은 사주의 집은 볼 때마다 같다', () => {
    const [a, b] = [buildHome({ style: 'water', accent: 'metal', symbol: 'rain' }), buildHome({ style: 'water', accent: 'metal', symbol: 'rain' })];
    expect(a.sprigs.map((sprigs) => [sprigs.kind, sprigs.count])).toEqual(b.sprigs.map((sprigs) => [sprigs.kind, sprigs.count]));
    expect(Array.from(a.sprigs[0]!.matrices.slice(0, 64))).toEqual(Array.from(b.sprigs[0]!.matrices.slice(0, 64)));
    expect(a.lamps).toEqual(b.lamps);
  }, 30_000);

  it('우세 오행이 같은 집도 일간에 따라 다섯 가지 지붕 실루엣이 생긴다', () => {
    const symbols: YardSymbol[] = ['field', 'tree', 'rain', 'gem', 'candle'];
    const heights = symbols.map((symbol) => {
      const { meshes } = buildHouse({ style: 'wood', accent: 'fire', symbol });
      return Math.max(...meshes.map(({ geometry }) => {
        geometry.computeBoundingBox();
        return geometry.boundingBox!.max.y;
      }));
    });
    expect(new Set(heights).size).toBe(5);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(2);
  });

  it('같은 지붕의 형태를 유지하면서 둘째 오행의 마감색을 입힌다', () => {
    const finishOf = (accent: 'fire' | 'water') => buildHouse({ style: 'earth', accent, symbol: 'sun' }).meshes.map(({ geometry }) => {
      const position = geometry.getAttribute('position');
      const color = geometry.getAttribute('color');
      let red = 0;
      for (let index = 0; index < position.count; index++) {
        if (position.getY(index) > 5) red += color.getX(index);
      }
      return { vertices: position.count, red };
    });
    const fire = finishOf('fire');
    const water = finishOf('water');
    expect(fire.map(({ vertices }) => vertices)).toEqual(water.map(({ vertices }) => vertices));
    expect(fire.map(({ red }) => red)).not.toEqual(water.map(({ red }) => red));
    expect(finishOf('fire')).toEqual(fire);
  });

  it.each(SYMBOLS)('일간의 상징 %s가 제자리에 선다', (symbol) => {
    const plain = buildHome({ style: 'earth', accent: null, symbol: 'tree' });
    const build = buildHome({ style: 'earth', accent: null, symbol });
    const size = (target: typeof build) => target.meshes.reduce((sum, mesh) => sum + mesh.geometry.index!.count, 0) + target.sprigs.reduce((sum, sprigs) => sum + sprigs.count, 0);
    expect(size(build)).toBeGreaterThan(0);
    if (symbol !== 'tree') expect(size(build)).not.toBe(size(plain));
  }, 30_000);

  it.each(ELEMENTS)('둘째 오행 %s의 기념물이 더해진다', (accent) => {
    const without = buildHome({ style: 'wood', accent: null, symbol: 'gem' });
    const withIt = buildHome({ style: 'wood', accent, symbol: 'gem' });
    const size = (target: typeof withIt) => target.meshes.reduce((sum, mesh) => sum + mesh.geometry.index!.count, 0) + target.sprigs.reduce((sum, sprigs) => sum + sprigs.count, 0);
    expect(size(withIt)).toBeGreaterThan(size(without));
  }, 30_000);

  it('휴대폰에는 정원을 성기게 심는다', () => {
    const count = (lush: boolean) => buildHome({ style: 'fire', accent: null, symbol: 'candle' }, lush).sprigs.reduce((sum, sprigs) => sum + sprigs.count, 0);
    expect(count(false)).toBeLessThan(count(true) * 0.75);
  }, 30_000);

  it('빈 터에도 섬이 있다', () => {
    const lot = buildLot();
    expect(lot.meshes.length).toBeGreaterThan(1);
    expect(lot.lamps).toHaveLength(0);
  }, 30_000);

  it('수호 캐릭터와 상징, 기념물의 자리는 서로 겹치지 않고, 주인의 섬 안쪽에 있다', () => {
    const spots = [GUARDIAN_AT, EMBLEM_AT, KEEPSAKE_AT];
    for (const [index, a] of spots.entries()) {
      for (const b of spots.slice(index + 1)) expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeGreaterThan(1.6);
      expect(Math.hypot(a[0], a[2])).toBeLessThan(shoreAt(ISLANDS.home, Math.atan2(a[2], a[0])) - 1.5);
    }
    // 수호 캐릭터는 이웃의 섬에도 같은 자리에 선다.
    expect(Math.hypot(GUARDIAN_AT[0], GUARDIAN_AT[2])).toBeLessThan(shoreAt(ISLANDS.neighbour, Math.atan2(GUARDIAN_AT[2], GUARDIAN_AT[0])) - 1.5);
  });
});

describe('섬의 모양', () => {
  it('미니홈피 주인의 섬은 이웃 섬 네 개쯤을 가로세로로 늘어놓은 만큼 넓다', () => {
    expect(ISLANDS.home.half / ISLANDS.neighbour.half).toBeGreaterThan(4);
    expect(ISLANDS.home.half / ISLANDS.neighbour.half).toBeLessThan(4.6);
    for (const kind of KINDS) {
      const { half, corner, reach } = ISLANDS[kind];
      expect(corner).toBeGreaterThan(0);
      expect(corner).toBeLessThan(half);
      // 둑은 물가에서 한 미터 반 넘게 내려가 호수 바닥에 닿는다.
      expect(reach).toBeGreaterThan(half + 1.5);
    }
  });

  it('물가 선은 곧은 변에서 half이고, 둥근 모서리로 갈수록 멀어진다', () => {
    for (const kind of KINDS) {
      const shape = ISLANDS[kind];
      for (const side of [0, 1, 2, 3]) expect(shoreAt(shape, (side * Math.PI) / 2)).toBeCloseTo(shape.half, 9);
      expect(shoreAt(shape, Math.PI / 4)).toBeCloseTo((shape.half - shape.corner) * Math.SQRT2 + shape.corner, 9);
      let before = 0;
      for (let step = 0; step <= 45; step++) {
        const here = shoreAt(shape, (step / 180) * Math.PI);
        expect(here).toBeGreaterThanOrEqual(before - 1e-9);
        before = here;
      }
    }
  });

  it('물가는 그 선을 따라 반 미터 안팎으로만 구불거리고, reach에서는 호수 바닥이다', () => {
    for (const kind of KINDS) {
      const shape = ISLANDS[kind];
      for (const seed of [11, 23, 37, 41, 53, 71]) {
        const site = new Site(seed, [], shape);
        for (let step = 0; step < 72; step++) {
          const bearing = (step / 72) * Math.PI * 2;
          const [cos, sin] = [Math.cos(bearing), Math.sin(bearing)];
          const line = shoreAt(shape, bearing);
          expect(site.height(cos * (line - 1.15), sin * (line - 1.15))).toBe(0);
          expect(site.height(cos * (line - 0.6), sin * (line - 0.6))).toBeGreaterThan(WATER_LEVEL);
          expect(site.height(cos * (line + 0.8), sin * (line + 0.8))).toBeLessThan(WATER_LEVEL);
        }
        for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) expect(site.height(x * shape.reach, z * shape.reach)).toBeLessThan(-1.4);
      }
    }
  });
});

describe('주인의 섬과 이웃의 섬', () => {
  const builds = new Map(ELEMENTS.map((style) => [style, Object.fromEntries(KINDS.map((kind) => [kind, buildHome({ style, accent: 'water', symbol: 'gem' }, true, kind)])) as Record<IslandKind, Build>]));

  it.each(ELEMENTS)('%s: 무엇이든 제 섬의 reach 안에 그려진다', (style) => {
    for (const kind of KINDS) {
      const { built, scattered } = pointsOf(builds.get(style)![kind]);
      const reach = ISLANDS[kind].reach;
      for (const [x, , z] of [...built, ...scattered]) expect(Math.max(Math.abs(x), Math.abs(z))).toBeLessThanOrEqual(reach);
    }
  }, 30_000);

  it.each(ELEMENTS)('%s: 이웃의 섬에도 집은 창 하나 빠짐없이 지어진다', (style) => {
    const { home, neighbour } = builds.get(style)!;
    expect(panesOf(neighbour)).toBeGreaterThan(0);
    expect(panesOf(neighbour)).toBe(panesOf(home));
  }, 30_000);

  it.each(ELEMENTS)('%s: 이웃의 섬은 집과 땅, 물가와 나무 몇 그루뿐이라 훨씬 가볍다', (style) => {
    const { home, neighbour } = builds.get(style)!;
    const kinds = new Set(neighbour.sprigs.map((sprigs) => sprigs.kind));
    // 수련 잎도 없고, 움직이는 것도 켜 둔 등불도 없다.
    expect(kinds.has('pad')).toBe(false);
    expect(neighbour.lives).toEqual([]);
    expect(neighbour.lamps).toEqual([]);
    // 나무와 덤불의 잎은 있다.
    expect(kinds.has('leaf') || kinds.has('needle')).toBe(true);
    expect(trianglesOf(neighbour)).toBeLessThan(trianglesOf(home) * 0.65);
    expect(trianglesOf(neighbour)).toBeLessThan(100_000);
    const instances = (build: Build) => build.sprigs.reduce((sum, sprigs) => sum + sprigs.count, 0);
    expect(instances(neighbour)).toBeLessThan(instances(home) * 0.75);
  }, 30_000);

  it.each(ELEMENTS)('%s: 다리가 닿는 자리(변의 가운데와 네 모서리) 바깥으로는 아무것도 나와 있지 않다', (style) => {
    for (const kind of KINDS) {
      const { built, scattered } = pointsOf(builds.get(style)![kind]);
      for (let index = 0; index < 8; index++) {
        const bearing = (index / 8) * Math.PI * 2;
        const [cos, sin] = [Math.cos(bearing), Math.sin(bearing)];
        const foot = shoreAt(ISLANDS[kind], bearing) - 0.75;
        // 다리의 발에서 바깥으로 두 걸음, 다리 폭만큼: 가장 짧은 다리(4.5미터)의 아치에 난간과 등불을 더한 높이까지.
        // 그 위로 드리운 나뭇가지는 다리에 닿지 않는다.
        const inWay = ([x, y, z]: [number, number, number]) => {
          const out = x * cos + z * sin - foot;
          const across = Math.abs(-x * sin + z * cos);
          const top = 0.9 + 0.72 * Math.sin((Math.PI * Math.min(Math.max(out, 0), 2.25)) / 4.5);
          return y > WATER_LEVEL - 0.1 && y < top && out > -0.1 && out < 2 && across < 0.75;
        };
        expect([...built, ...scattered].filter(inWay)).toEqual([]);
      }
    }
  }, 30_000);

  it('빈 터도 두 가지로 지어진다: 이웃의 것은 훨씬 가볍다', () => {
    const [home, neighbour] = KINDS.map((kind) => buildLot(true, kind));
    expect(trianglesOf(neighbour!)).toBeLessThan(trianglesOf(home!) * 0.5);
  }, 30_000);
});
