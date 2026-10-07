import { afterEach, describe, expect, it, vi } from 'vitest';

const { loadModelBounds } = vi.hoisted(() => ({ loadModelBounds: vi.fn() }));
vi.mock('../edit/bounds', () => ({ loadModelBounds, modelBounds: () => undefined }));

import { measureLayoutCatalog } from '../edit/layout';
import type { LocalBox } from '../edit/objects';

const box: LocalBox = { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] };

afterEach(() => loadModelBounds.mockReset());

describe('매장 배치에 쓸 크기 재기', () => {
  it('섬에 놓인 모델 하나를 잴 수 없어도(파일 404) 배치할 기물의 크기는 돌려준다', async () => {
    loadModelBounds.mockImplementation(async (url: string) => {
      if (url === '/models/gone.glb') throw new Error('404');
      return box;
    });
    const items = await measureLayoutCatalog(['/models/gone.glb', '/models/kept.glb', '/models/gone.glb']);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.bounds === box)).toBe(true);
    expect(loadModelBounds.mock.calls.filter(([url]) => url === '/models/gone.glb')).toHaveLength(1);
  });

  it('배치가 놓을 기물 자체를 잴 수 없으면 실패한다', async () => {
    loadModelBounds.mockRejectedValue(new Error('모델의 크기를 측정할 수 없어요.'));
    await expect(measureLayoutCatalog()).rejects.toThrow('모델의 크기를 측정할 수 없어요.');
  });
});
