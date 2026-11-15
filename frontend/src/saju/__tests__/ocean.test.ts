import { Matrix4, OrthographicCamera, PerspectiveCamera, Vector3, Vector4, WebGLCoordinateSystem, WebGPUCoordinateSystem, type CoordinateSystem } from 'three';
import { describe, expect, it } from 'vitest';

import { AZIMUTH } from '../scene/frames';
import { WATER_LEVEL } from '../scene/mood';
import { CASCADES } from '../scene/ocean/FFTWaves';
import { clipNear, Mirror } from '../scene/ocean/mirror';
import { COVER_MARGIN, onRing, placeRing, ringCorners, ringGeometry, ringPoint, SKIRT, type RingPlace } from '../scene/ocean/ring';
import { BANK, bankHeight, BED, crestLimit, limitCrest, OPEN_CREST, outside, SHORE_CALM, SHORE_CREST, shoreAt, swellShare, WATERLINE, type OceanIsland } from '../scene/ocean/shore';
import { bandVariance, GRAVITY, peakWavelength } from '../scene/ocean/spectrum';
import { heightScale, SHORTEST_WAVE, spectrumOf, SWELL_CUTOFF, SWELL_WAVES, VILLAGE_SEA, WAVE_COUNT, WaveField, WIND_WAVES } from '../scene/ocean/waves';
import { ISLANDS, shoreAt as terrainShore } from '../scene/terrain';

const home: OceanIsland = { x: 0, z: 0, ...ISLANDS.home };
/** A neighbour across a channel four metres wide from the home, whatever size the home is built. */
const EAST = ISLANDS.home.half + 4 + ISLANDS.neighbour.half;
const east: OceanIsland = { x: EAST, z: 0, ...ISLANDS.neighbour };

describe('바다가 아는 물가', () => {
  it('섬의 물가선은 땅이 짓는 둥근 네모와 같다', () => {
    for (const shape of [ISLANDS.home, ISLANDS.neighbour]) {
      const island = { x: 3, z: -2, ...shape };
      for (let step = 0; step < 48; step++) {
        const bearing = (step / 48) * Math.PI * 2;
        const reach = terrainShore(shape, bearing);
        expect(outside(island, island.x + Math.cos(bearing) * reach, island.z + Math.sin(bearing) * reach)).toBeCloseTo(0, 6);
      }
    }
  });

  it('둑은 잔디에서 시작해 호수 바닥에서 끝나고, 물은 그 사이 몇 센티미터 밖에서 둑을 만난다', () => {
    expect(bankHeight(BANK.lawn)).toBeCloseTo(0, 9);
    expect(bankHeight(BANK.bed)).toBeCloseTo(BED, 9);
    for (let out = BANK.lawn; out < BANK.bed; out += 0.05) expect(bankHeight(out + 0.05)).toBeLessThanOrEqual(bankHeight(out) + 1e-12);
    expect(bankHeight(WATERLINE)).toBeCloseTo(WATER_LEVEL, 6);
    expect(WATERLINE).toBeGreaterThan(0);
    expect(WATERLINE).toBeLessThan(0.15);
  });

  it('물가에서의 거리와 깊이는 가장 가까운 섬의 것이다', () => {
    const islands = [home, east];
    const atShore = shoreAt(islands, ISLANDS.home.half + WATERLINE, 0);
    expect(atShore.distance).toBeCloseTo(0, 6);
    expect(atShore.depth).toBeCloseTo(0, 6);
    // Out in the channel between the two islands, the nearer bank is the one measured.
    const channel = shoreAt(islands, EAST - ISLANDS.neighbour.half - 1, 0.3);
    expect(channel.distance).toBeCloseTo(1 - WATERLINE, 6);
    expect(channel.depth).toBeGreaterThan(0.5);
    expect(shoreAt(islands, 0, 0).distance).toBeLessThan(-6);
    expect(shoreAt(islands, 0, ISLANDS.home.half + 20).depth).toBeCloseTo(WATER_LEVEL - BED, 9);
    expect(shoreAt([], 3, 3).distance).toBe(Infinity);
  });
});

describe('파도의 크기', () => {
  const params = spectrumOf(VILLAGE_SEA);

  it('마을의 바람은 몇 미터에서 수십 미터 길이의 파도를 낸다', () => {
    const peak = peakWavelength(params);
    expect(peak).toBeGreaterThan(5);
    expect(peak).toBeLessThan(12);
    const waves = new WaveField();
    for (let index = 0; index < WAVE_COUNT; index++) {
      const length = waves.ampQ[index * 4 + 3]!;
      expect(length).toBeGreaterThanOrEqual(SWELL_CUTOFF - 1e-6);
      expect(length).toBeLessThan(40);
      // Each wave moves at the pace of one twice its length, the village's metre being two of ours.
      const omega = waves.dirK[index * 4 + 3]!;
      expect(omega).toBeCloseTo(Math.sqrt(GRAVITY * ((2 * Math.PI) / length)), 4);
    }
  });

  it('스펙트럼 전체를 늘이면 열린 물의 유의파고가 마을의 것이 된다', () => {
    const scale = heightScale(VILLAGE_SEA);
    const variance = bandVariance((2 * Math.PI) / 60, (2 * Math.PI) / SHORTEST_WAVE, params, 8000) * scale * scale;
    expect(4 * Math.sqrt(variance)).toBeCloseTo(VILLAGE_SEA.height, 3);
    // The wind's long waves are its share of that: most of it, below the whole. The swell under them is its own height.
    const waves = new WaveField();
    const height = (from: number, to: number) => {
      let sum = 0;
      for (let index = from; index < to; index++) sum += waves.ampQ[index * 4]! ** 2;
      return 4 * Math.sqrt(sum / 2);
    };
    expect(height(0, WIND_WAVES)).toBeGreaterThan(VILLAGE_SEA.height * 0.4);
    expect(height(0, WIND_WAVES)).toBeLessThan(VILLAGE_SEA.height);
    expect(height(WIND_WAVES, WAVE_COUNT)).toBeCloseTo(VILLAGE_SEA.swell.height, 0);
    expect(WIND_WAVES + SWELL_WAVES).toBe(WAVE_COUNT);
  });

  it('너울은 바람과 따로, 처음 선 카메라 쪽으로 밀려와 그 마루의 빛과 그늘이 보인다', () => {
    const waves = new WaveField();
    // The camera stands at AZIMUTH from the scene's middle; a wave rolling toward it runs that way over the water.
    const toward = { x: Math.sin(AZIMUTH), z: Math.cos(AZIMUTH) };
    const peak = VILLAGE_SEA.swell.length;
    for (let index = WIND_WAVES; index < WAVE_COUNT; index++) {
      const o = index * 4;
      expect(waves.dirK[o]! * toward.x + waves.dirK[o + 1]! * toward.z).toBeGreaterThan(Math.cos((50 * Math.PI) / 180));
      const length = waves.ampQ[o + 3]!;
      expect(length).toBeGreaterThan(peak * 0.6);
      expect(length).toBeLessThan(peak * 1.4);
    }
    // Far longer than the wind's peak, and steeper than its long waves: the sea heaves under the ripples.
    expect(peak).toBeGreaterThan(peakWavelength(params) * 1.8);
  });

  it('잔물결의 세 판은 너울이 끝나는 데서부터 빈틈없이 이어지고, 판마다 제 격자로 그릴 수 있다', () => {
    expect(CASCADES[0]!.kLow).toBeCloseTo((2 * Math.PI) / SWELL_CUTOFF, 9);
    for (let index = 1; index < CASCADES.length; index++) expect(CASCADES[index]!.kLow).toBeCloseTo(CASCADES[index - 1]!.kHigh, 9);
    expect((2 * Math.PI) / CASCADES[CASCADES.length - 1]!.kHigh).toBeCloseTo(SHORTEST_WAVE, 9);
    for (const cascade of CASCADES) {
      // A tile holds its longest wave several times over, and its grid two texels to its shortest.
      expect(cascade.size).toBeGreaterThan(((2 * Math.PI) / cascade.kLow) * 4);
      expect((cascade.size / 128) * 2).toBeLessThanOrEqual(cascade.minWave);
    }
  });

  it('마루는 잔디에 닿지 않는다: 물가에서는 한 뼘, 열린 물에서도 잔디 아래다', () => {
    expect(crestLimit(0)).toBeCloseTo(SHORE_CREST, 9);
    expect(crestLimit(1e3)).toBeCloseTo(OPEN_CREST, 9);
    for (let distance = 0; distance < 10; distance += 0.25) expect(crestLimit(distance + 0.25)).toBeGreaterThanOrEqual(crestLimit(distance));
    // The lawn is at 0, the water's rest 30 cm below it.
    expect(WATER_LEVEL + SHORE_CREST).toBeLessThan(-0.15);
    expect(WATER_LEVEL + OPEN_CREST).toBeLessThan(-0.05);
    for (const limit of [SHORE_CREST, OPEN_CREST]) {
      for (const height of [0.001, 0.05, 0.2, 1, 10]) {
        const held = limitCrest(height, limit);
        expect(held).toBeLessThanOrEqual(limit);
        expect(held).toBeLessThanOrEqual(height);
      }
      expect(limitCrest(limit, limit)).toBeLessThan(limit * 0.7);
      expect(limitCrest(-0.3, limit)).toBe(-0.3);
      // A low crest is left almost as it is.
      expect(limitCrest(0.01, limit)).toBeGreaterThan(0.0095);
    }
  });

  it('너울은 물가로 갈수록 잦아들고, 못에서는 고요하다', () => {
    expect(swellShare(-1)).toBe(0);
    expect(swellShare(0)).toBeCloseTo(0.3, 9);
    expect(swellShare(100)).toBeCloseTo(1, 9);
    // The swell rises far over what the lawns allow out in the open; held under the limit there, no crest reaches a
    // lawn, at the shore or away from it, while the troughs between keep their full depth.
    const waves = new WaveField();
    let highest = -Infinity;
    let lowest = Infinity;
    for (let step = 0; step < 400; step++) {
      const x = (step * 7.31) % 90;
      const z = (step * 3.17) % 70;
      const t = step * 0.37;
      const height = waves.heightAt(x, z, t);
      highest = Math.max(highest, height);
      lowest = Math.min(lowest, height);
      for (const distance of [0, 2, SHORE_CALM, 100]) {
        const held = limitCrest(height * swellShare(distance), crestLimit(distance));
        expect(WATER_LEVEL + held).toBeLessThan(-0.05);
      }
    }
    expect(highest).toBeGreaterThan(OPEN_CREST);
    expect(highest).toBeLessThanOrEqual(waves.crest);
    expect(lowest).toBeLessThan(-OPEN_CREST);
  });
});

/** An orthographic camera as the village's canvas makes one: `width` by `height` pixels, `zoom` pixels a metre. */
function camera(width: number, height: number, zoom: number, azimuth: number, tilt: number, target: Vector3, offset?: [number, number]): OrthographicCamera {
  const view = new OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 1, 520);
  view.coordinateSystem = WebGPUCoordinateSystem;
  view.zoom = zoom;
  const distance = 120;
  view.position.set(target.x + Math.cos(tilt) * Math.sin(azimuth) * distance, target.y + Math.sin(tilt) * distance, target.z + Math.cos(tilt) * Math.cos(azimuth) * distance);
  view.lookAt(target);
  view.updateMatrixWorld();
  if (offset) view.setViewOffset(width, height, offset[0], offset[1], width, height);
  view.updateProjectionMatrix();
  return view;
}

/** Where the picture's point (x, y), in normalized device coordinates, meets the water. */
function seen(view: OrthographicCamera, x: number, y: number): Vector3 {
  const ahead = view.getWorldDirection(new Vector3());
  const point = new Vector3(x, y, 0).unproject(view);
  return point.addScaledVector(ahead, (WATER_LEVEL - point.y) / ahead.y);
}

describe('물결 원판', () => {
  const geometry = ringGeometry(48);
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex()!;

  it('고리는 고르게 놓이고 면은 모두 위를 본다', () => {
    let rings = 0;
    for (let ring = 1; ring <= 48; ring++) rings += ringCorners(ring);
    expect(position.count).toBe(1 + rings + SKIRT.length * ringCorners(48));
    let area = 0;
    let longest = 0;
    for (let face = 0; face < index.count; face += 3) {
      const [a, b, c] = [index.getX(face), index.getX(face + 1), index.getX(face + 2)].map((at) => new Vector3().fromBufferAttribute(position, at)) as [Vector3, Vector3, Vector3];
      const up = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).y;
      expect(up).toBeGreaterThan(0);
      area += up / 2;
      if (Math.max(a.length(), b.length(), c.length()) <= 1 + 1e-9) longest = Math.max(longest, a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    }
    // The faces tile the whole skirt's polygon with no gap and no overlap.
    const sides = ringCorners(48);
    const outer = SKIRT[SKIRT.length - 1]!;
    expect(area).toBeCloseTo(0.5 * sides * outer * outer * Math.sin((2 * Math.PI) / sides), 1);
    // Inside the disc no edge is much longer than the rings are apart.
    expect(longest).toBeLessThan((1 / 48) * 1.6);
  });

  it('어느 쪽으로 돌고 기울고 당기고 밀어도 원판이 그림의 네 귀를 다 덮는다', () => {
    const sides = ringCorners(128);
    // The disc's last ring is a polygon: it holds a circle this much smaller than itself.
    const inner = Math.cos(Math.PI / sides);
    const place: RingPlace = { centre: new Vector3(), across: new Vector3(), along: new Vector3() };
    const point = new Vector3();
    const canvases: [number, number][] = [
      [1440, 900],
      [390, 844],
      [1024, 1366],
      [1080, 1080],
      [2560, 1080],
    ];
    let checked = 0;
    for (const [width, height] of canvases) {
      for (let turn = 0; turn < 360; turn += 30) {
        for (const tilt of [20, 33, 45, 58, 70]) {
          for (const zoom of [0.6, 1, 3.2]) {
            for (const frame of [8, 40]) {
              for (const offset of [undefined, [-180, 40] as [number, number], [120, -260] as [number, number]]) {
                const pixels = (Math.min(width / (2 * frame), height / (2 * frame)) * zoom) / 1;
                const view = camera(width, height, pixels, (turn * Math.PI) / 180, (tilt * Math.PI) / 180, new Vector3(frame === 8 ? 0 : 6, 1.5, frame === 8 ? 0 : -4), offset);
                expect(placeRing(view, width, height, place)).toBe(true);
                for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 1], [1, 0], [0, -1], [-1, 0]] as const) {
                  const water = seen(view, x, y);
                  const at = onRing(place, water.x, water.z);
                  expect(Math.hypot(at.x, at.z)).toBeLessThanOrEqual((inner / COVER_MARGIN) * 1.0001);
                }
                // And the disc lies where it says: its point (0.3, -0.6) falls back where it was put.
                const back = onRing(place, ringPoint(place, 0.3, -0.6, point).x, point.z);
                expect(back.x).toBeCloseTo(0.3, 9);
                expect(back.z).toBeCloseTo(-0.6, 9);
                checked += 1;
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(5 * 12 * 5 * 3 * 2 * 3);
  });

  it('원판은 놓인 자리에서도 위를 본다', () => {
    const place: RingPlace = { centre: new Vector3(), across: new Vector3(), along: new Vector3() };
    for (let turn = 0; turn < 360; turn += 45) {
      placeRing(camera(1440, 900, 60, (turn * Math.PI) / 180, (33 * Math.PI) / 180, new Vector3()), 1440, 900, place);
      expect(place.across.x * place.along.z - place.across.z * place.along.x).toBeGreaterThan(0);
    }
  });

  it('카메라가 물을 내려다보지 않으면 놓지 않는다', () => {
    const place: RingPlace = { centre: new Vector3(), across: new Vector3(), along: new Vector3() };
    const view = new OrthographicCamera(-100, 100, 100, -100, 1, 500);
    view.position.set(0, 5, 0);
    view.lookAt(10, 5, 0);
    view.updateMatrixWorld();
    expect(placeRing(view, 200, 200, place)).toBe(false);
  });
});

describe('거울', () => {
  /** Where `point` lands in the depth `projection` gives it, for its coordinate system: from the near plane's to the far one's. */
  const depth = (projection: Matrix4, point: Vector3) => {
    const clip = new Vector4(point.x, point.y, point.z, 1).applyMatrix4(projection);
    return clip.z / clip.w;
  };

  it('비스듬한 앞면은 수면에 놓이고, 수면 아래는 잘리고 위는 남는다', () => {
    const cases: [CoordinateSystem, () => Matrix4][] = [];
    for (const system of [WebGLCoordinateSystem, WebGPUCoordinateSystem] as const) {
      cases.push([system, () => new OrthographicCamera(-30, 30, 20, -20, 1, 400).projectionMatrix.clone()]);
      cases.push([system, () => new PerspectiveCamera(40, 1.5, 1, 400).projectionMatrix.clone()]);
    }
    for (const [system, make] of cases) {
      const projection = make();
      // Rebuilt for its coordinate system.
      const owner = projection.elements[15] === 1 ? new OrthographicCamera(-30, 30, 20, -20, 1, 400) : new PerspectiveCamera(40, 1.5, 1, 400);
      owner.coordinateSystem = system;
      owner.updateProjectionMatrix();
      projection.copy(owner.projectionMatrix);
      // A plane in the camera's space, tilted, that the camera stands behind: what is kept lies beyond it, on the side
      // its normal faces, as what stands over the water lies beyond the surface from the mirror's camera.
      const normal = new Vector3(0, 0.84, -0.54).normalize();
      const onPlane = new Vector3(2, -3, -60);
      const plane = new Vector4(normal.x, normal.y, normal.z, -normal.dot(onPlane));
      clipNear(projection, plane, system);
      const near = system === WebGLCoordinateSystem ? -1 : 0;
      expect(depth(projection, onPlane)).toBeCloseTo(near, 5);
      const above = onPlane.clone().addScaledVector(normal, 3);
      const below = onPlane.clone().addScaledVector(normal, -3);
      expect(depth(projection, above)).toBeGreaterThan(near);
      expect(depth(projection, above)).toBeLessThan(1);
      expect(depth(projection, below)).toBeLessThan(near);
    }
  });

  it('물 위의 것은 그 그림자가 비친 물에서 거울의 같은 자리에서 읽힌다', () => {
    const mirror = new Mirror();
    for (const [turn, tilt, offset] of [
      [45, 33, undefined],
      [200, 20, [-160, 30]],
      [300, 70, [90, -120]],
    ] as const) {
      const view = camera(1440, 900, 28, (turn * Math.PI) / 180, (tilt * Math.PI) / 180, new Vector3(10, 1.5, -5), offset ? [offset[0], offset[1]] : undefined);
      mirror.aim(view);
      const ahead = view.getWorldDirection(new Vector3());
      for (const thing of [new Vector3(10, 2.1, 3), new Vector3(-4, 6.5, -12), new Vector3(18, 0.2, -6)]) {
        const image = new Vector3(thing.x, 2 * WATER_LEVEL - thing.y, thing.z);
        const water = image.clone().addScaledVector(ahead, (WATER_LEVEL - image.y) / ahead.y);
        const read = (point: Vector3) => new Vector4(point.x, point.y, point.z, 1).applyMatrix4(mirror.matrix);
        const [a, b] = [read(thing), read(water)];
        expect(a.x / a.w).toBeCloseTo(b.x / b.w, 6);
        expect(a.y / a.w).toBeCloseTo(b.y / b.w, 6);
      }
      // The picture is read with y from its top, as node materials read every picture.
      const top = seen(view, 0, 1);
      const bottom = seen(view, 0, -1);
      const [high, low] = [top, bottom].map((point) => new Vector4(point.x, point.y, point.z, 1).applyMatrix4(mirror.matrix));
      expect(high!.y).toBeLessThan(low!.y);
    }
    mirror.dispose();
  });
});
