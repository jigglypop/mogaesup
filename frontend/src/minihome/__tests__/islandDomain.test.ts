import { describe, expect, it, vi } from 'vitest';

import { createIslandStore, islandBinding, ISLAND_DOMAIN, parseIsland } from '../islands/domain';

describe('섬 종류 저장', () => {
  it('모르는 종류나 없는 값은 숲으로 읽는다', () => {
    expect(parseIsland(undefined)).toBe('forest');
    expect(parseIsland(null)).toBe('forest');
    expect(parseIsland('city')).toBe('forest');
    expect(parseIsland({ version: 1 })).toBe('forest');
    expect(parseIsland({ version: 1, template: 'moon' })).toBe('forest');
    expect(parseIsland({ version: 1, template: 'cafe' })).toBe('cafe');
  });

  it('직렬화한 값을 그대로 다시 읽는다', () => {
    const store = createIslandStore();
    const binding = islandBinding(store);
    store.set('winter');
    const saved = binding.serialize();
    expect(binding.key).toBe(ISLAND_DOMAIN);
    expect(saved).toEqual({ version: 1, template: 'winter' });

    const other = createIslandStore();
    islandBinding(other).hydrate(JSON.parse(JSON.stringify(saved)));
    expect(other.getState()).toBe('winter');
  });

  it('바뀔 때만 revision이 오르고 알린다', () => {
    const store = createIslandStore();
    const heard = vi.fn();
    store.subscribe(heard);
    const before = store.revision();
    store.set('forest');
    expect(store.revision()).toBe(before);
    expect(heard).not.toHaveBeenCalled();
    store.set('park');
    expect(store.revision()).toBe(before + 1);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('미리 읽기는 적용을 미루고, 비우면 숲으로 돌아간다', () => {
    const store = createIslandStore('city');
    const binding = islandBinding(store);
    const apply = binding.prepareHydrate!({ version: 1, template: 'farm' });
    expect(store.getState()).toBe('city');
    apply();
    expect(store.getState()).toBe('farm');
    binding.reset!();
    expect(store.getState()).toBe('forest');
  });
});
