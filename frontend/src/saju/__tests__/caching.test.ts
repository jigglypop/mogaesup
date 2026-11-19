import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DataTexture } from 'three';

import { Builder, materialFor, mergeBuilds } from '../scene/build';
import { keepEstate, keptBuild, keptEstate } from '../scene/kept';
import { detailTexture, foamTexture } from '../scene/ocean/detailNormals';
import { detailData, foamData, SEA_TILE } from '../scene/ocean/seaTiles';
import { paint, paintsPending } from '../scene/painter';
import { nameOf, shelving } from '../scene/shelf';
import { sprigGeometry, sprigMaterial } from '../scene/sprigs';
import { paintSurface, TILE } from '../scene/surfaceRecipes';
import { surfaceMaps } from '../scene/surfaces';

const mine = vi.fn();
const get = vi.fn();
const village = vi.fn();
vi.mock('../../api/endpoints', () => ({ homeApi: { mine, get }, sajuApi: { village } }));

const { askEarly, pageArrived, takeEarly } = await import('../early');

beforeEach(() => {
  mine.mockReset().mockResolvedValue({ profile: 'mine' });
  get.mockReset().mockResolvedValue({ profile: 'theirs' });
  village.mockReset().mockResolvedValue({ saju: null, village: [] });
});

describe('일찍 읽어 두는 섬', () => {
  it('페이지 코드가 오기 전에 한 번 묻고, 읽을 때 그 답을 한 번 넘겨준다', async () => {
    askEarly('sol', 'moon');
    askEarly('sol', 'moon');
    expect(get).toHaveBeenCalledTimes(1);
    expect(village).toHaveBeenCalledTimes(2);
    const answers = takeEarly('sol', 'moon');
    await expect(answers?.view).resolves.toEqual({ profile: 'theirs' });
    expect(takeEarly('sol', 'moon')).toBeNull();
  });

  it('다른 사람이 보는 섬의 답은 넘겨주지 않는다', () => {
    askEarly('sol', null);
    expect(takeEarly('sol', 'moon')).toBeNull();
    expect(takeEarly('sol', null)).not.toBeNull();
  });

  it('주인은 자기 집을 자기 것으로 읽는다', async () => {
    askEarly('moon', 'moon');
    expect(mine).toHaveBeenCalledTimes(1);
    expect(takeEarly('moon', 'moon')?.mine).toBeNull();
  });

  it('페이지 코드가 오면 더는 미리 묻지 않는다', () => {
    pageArrived();
    askEarly('star', null);
    expect(get).not.toHaveBeenCalled();
    expect(takeEarly('star', null)).toBeNull();
  });
});

describe('타일 칠하기', () => {
  it('일꾼이 없는 곳에서는 그 자리에서 칠해 채운다', () => {
    const fill = vi.fn();
    paint({ kind: 'foam' }, () => [new Uint8Array([1, 2, 3, 4])], fill);
    expect(fill).toHaveBeenCalledWith([new Uint8Array([1, 2, 3, 4])]);
    expect(paintsPending()).toBe(0);
  });

  it('표면의 무늬와 결은 받은 그대로 텍스처에 들어간다', () => {
    const maps = surfaceMaps('brick');
    const painted = paintSurface('brick');
    expect((maps.map as DataTexture).image.data).toEqual(painted.colors);
    expect((maps.normalMap as DataTexture).image.data).toEqual(painted.normals);
    expect(painted.colors).toHaveLength(TILE * TILE * 4);
    expect(surfaceMaps('brick')).toBe(maps);
  });

  it('호수의 물결과 거품도 받은 그대로 들어간다', () => {
    expect(foamTexture().image.data).toEqual(foamData());
    expect(detailTexture(0.4).image.data).toEqual(detailData(0.4));
    expect(foamData()).toHaveLength(SEA_TILE * SEA_TILE * 4);
  });
});

describe('흩어 심는 것', () => {
  it('잎이 있는 것은 모두 한 프로그램으로 그리고, 바람과 빛을 받는 정도는 모양의 꼭짓점에 싣는다', () => {
    const leaf = sprigMaterial('leaf');
    const frond = sprigMaterial('frond');
    expect(leaf).not.toBe(frond);
    expect((leaf as unknown as { positionNode: unknown }).positionNode).toBe((frond as unknown as { positionNode: unknown }).positionNode);
    expect((leaf as unknown as { normalNode: unknown }).normalNode).toBe((frond as unknown as { normalNode: unknown }).normalNode);
    const manner = sprigGeometry('leaf').getAttribute('manner');
    expect(manner.itemSize).toBe(2);
    expect(manner.getX(0)).toBeCloseTo(0.016, 6);
    expect(manner.getY(0)).toBeCloseTo(0.72, 6);
    expect(sprigGeometry('rock').getAttribute('manner')).toBeUndefined();
  });

  it('돌과 자갈은 한 가지 색 노드를 같이 쓴다', () => {
    const rock = sprigMaterial('rock') as unknown as { colorNode: unknown };
    const pebble = sprigMaterial('pebble') as unknown as { colorNode: unknown };
    expect(rock.colorNode).toBe(pebble.colorNode);
  });
});

describe('지어 둔 것', () => {
  it('메시마다 재료를 데이터로 적어 두고, 그것으로 같은 재료를 다시 찾는다', () => {
    const b = new Builder(3);
    b.box([1, 1, 1], [0, 0, 0], '#a0522d', { surface: 'wood' });
    b.box([1, 1, 1], [2, 0, 0], '#ffffff', { glow: '#ffcc66', power: 2 });
    b.pane([1, 1], [0, 1, 0], 'paper', 1.5);
    const merged = mergeBuilds([{ build: b.finish(), at: [1, 0, 0] }]);
    expect(merged.meshes.length).toBe(3);
    for (const mesh of merged.meshes) {
      expect(mesh.look).toBeDefined();
      expect(materialFor(mesh.look!)).toBe(mesh.material);
    }
  });

  it('개발 중과 시험에서는 방문 사이에 남기지 않고, 이 페이지에서 지은 것만 다시 준다', () => {
    expect(shelving).toBe(false);
    const make = vi.fn(() => new Builder(1).box([1, 1, 1], [0, 0, 0], '#888888').finish());
    const first = keptBuild('test|box', make);
    const second = keptBuild('test|box', make);
    expect(make).toHaveBeenCalledTimes(1);
    expect(first).not.toBeInstanceOf(Promise);
    expect(second).not.toBe(first);
    const [a, b] = [first, second].map((build) => (build as Exclude<typeof build, Promise<unknown>>).meshes[0]!.geometry);
    expect(a!.getAttribute('position').array).toBe(b!.getAttribute('position').array);
    expect(a!.getAttribute('position')).not.toBe(b!.getAttribute('position'));
  });

  it('제 섬의 영지는 최근에 본 사주 몇 개의 것만 남기고, 오래된 것부터 놓는다', () => {
    const build = () => new Builder(2).box([1, 1, 1], [0, 0, 0], '#888888').finish();
    const charts = Array.from({ length: 5 }, () => ({}));
    for (const chart of charts.slice(0, 4)) keepEstate(chart, 'landings', build());
    // 다시 본 사주는 가장 최근 것이 된다.
    expect(keptEstate(charts[0]!, 'landings')).not.toBeNull();
    keepEstate(charts[4]!, 'landings', build());
    expect(keptEstate(charts[1]!, 'landings')).toBeNull();
    for (const chart of [charts[0]!, ...charts.slice(2)]) expect(keptEstate(chart, 'landings')).not.toBeNull();
  });

  it('긴 글은 늘 같은 짧은 이름이 된다', () => {
    expect(nameOf('{"a":1}')).toBe(nameOf('{"a":1}'));
    expect(nameOf('{"a":1}')).not.toBe(nameOf('{"a":2}'));
  });
});
