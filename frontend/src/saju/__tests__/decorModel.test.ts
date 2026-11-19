import { Group } from 'three';
import { expect, it, vi } from 'vitest';

const { loads } = vi.hoisted(() => ({ loads: [] as string[] }));
vi.mock('three/addons/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder() {
      return this;
    }

    loadAsync(url: string) {
      loads.push(url);
      return Promise.resolve({ scene: new Group() });
    }
  },
}));

const { loadDecorModel } = await import('../scene/decorModel');

it('모두의 장식 모형은 남기고, 섬마다 다른 캐릭터 모형은 최근에 쓴 몇 개만 남긴다', async () => {
  const lantern = '/gltf/decor/deco-stone-lantern.glb';
  const shared = await loadDecorModel(lantern);
  const looks = Array.from({ length: 6 }, (_, index) => `/models/look-${index}.glb`);
  for (const look of looks.slice(0, 5)) await loadDecorModel(look);
  // 다시 쓴 것은 가장 최근 것이 되고, 그사이 가장 오래 쓰지 않은 것이 놓인다.
  await loadDecorModel(looks[1]!);
  await loadDecorModel(looks[5]!);
  loads.length = 0;
  expect(await loadDecorModel(lantern)).toBe(shared);
  for (const look of [looks[1]!, looks[3]!, looks[4]!, looks[5]!]) await loadDecorModel(look);
  expect(loads).toEqual([]);
  await loadDecorModel(looks[2]!);
  expect(loads).toEqual([looks[2]]);
});
