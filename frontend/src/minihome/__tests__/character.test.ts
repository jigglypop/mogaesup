import { describe, expect, it } from 'vitest';

import type { CatalogItem, Look } from '../../api/types';
import { playerModelUrl, wearsLook } from '../character';
import { FALLBACK_MINIME, fallbackModelUrl } from '../figures';

const minime = (id: string): CatalogItem => ({
  id,
  kind: 'minime',
  label: id,
  emoji: '🙂',
  modelUrl: `/models/${id}.glb`,
  thumbnailUrl: null,
  clips: ['idle', 'walk'],
  source: 'factory',
  sourceRef: null,
  status: 'published',
  sortOrder: 100,
});

const look = (changes: Partial<Look>): Look => ({
  request: { body: { jobId: 'b', version: 'v' }, parts: {}, hairColor: null, colors: {} },
  status: 'ready',
  worn: true,
  modelUrl: '/models/look.glb',
  error: null,
  updatedAt: '2026-09-30T00:00:00Z',
  ...changes,
});

describe('섬에서 걷는 모델', () => {
  const minimes = [minime('hero')];

  it('입은 내 모습이 먼저, 그다음 고른 미니미다', () => {
    expect(playerModelUrl(look({}), 'hero', minimes)).toBe('/models/look.glb');
    expect(playerModelUrl(look({ worn: false }), 'hero', minimes)).toBe('/models/hero.glb');
    expect(playerModelUrl(null, 'hero', minimes)).toBe('/models/hero.glb');
  });

  it('다시 만드는 중이거나 실패해도 마지막으로 완성된 모습을 입는다', () => {
    expect(playerModelUrl(look({ status: 'baking' }), 'hero', minimes)).toBe('/models/look.glb');
    expect(playerModelUrl(look({ status: 'failed', error: { code: 'x', message: 'y' } }), 'hero', minimes)).toBe('/models/look.glb');
    expect(wearsLook(look({ modelUrl: null, status: 'baking' }))).toBe(false);
    expect(playerModelUrl(look({ modelUrl: null, status: 'baking' }), 'hero', minimes)).toBe('/models/hero.glb');
  });

  it('없어진 포장 미니미나 내려간 미니미를 고른 섬은 기본 미니미로 걷는다', () => {
    expect(FALLBACK_MINIME).toBe('man');
    expect(fallbackModelUrl()).toBe('/gltf/man.glb');
    for (const gone of ['teacher', 'trainer_red', 'retired-hero']) expect(playerModelUrl(null, gone, minimes)).toBe(fallbackModelUrl());
  });
});
