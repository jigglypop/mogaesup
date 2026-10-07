import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-three/fiber', async (original) => ({
  ...(await original<typeof import('@react-three/fiber')>()),
  useFrame: vi.fn(),
}));

import type { NPCInstanceData, NPCTemplate } from 'gaesup-world';

import { mount } from '../../__tests__/mount';
import type { CatalogItem } from '../../api/types';
import { createGreetingStore, createResidentStore } from '../../minihome/residents';
import { ResidentsWorld } from '../../minihome/ResidentsWorld';
import { clearNpcLayer, setNpcLayer } from '../npcLayer';

/** The runtime's NPC store as the layers see it: one state, replaced whole on every write. */
function fakeRuntime() {
  let state = { templates: new Map<string, NPCTemplate>(), instances: new Map<string, NPCInstanceData>() };
  const writes: (typeof state)[] = [];
  const npcStore = {
    getState: () => state,
    setState: (next: typeof state) => {
      state = { ...state, ...next };
      writes.push(state);
    },
  };
  return { npcStore, writes, state: () => state };
}

const template = (id: string): NPCTemplate => ({ id, name: id, category: 'creature', baseParts: [], clothingParts: [] });
const instance = (id: string, templateId: string): NPCInstanceData =>
  ({ id, templateId, name: id, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) as NPCInstanceData;

describe('NPC layers', () => {
  it('replaces only its own entries and keeps the others as the same objects', () => {
    const runtime = fakeRuntime();
    const pet = instance('pet:1', 'pet-breed:pug');
    setNpcLayer(runtime, 'pet:', [template('pet-breed:pug')], [pet]);
    setNpcLayer(runtime, 'resident:', [template('resident:a')], [instance('r1', 'resident:a')]);
    setNpcLayer(runtime, 'resident:', [template('resident:b')], [instance('r2', 'resident:b')]);
    const state = runtime.state();
    expect([...state.instances.keys()].sort()).toEqual(['pet:1', 'r2']);
    expect([...state.templates.keys()].sort()).toEqual(['pet-breed:pug', 'resident:b']);
    expect(state.instances.get('pet:1')).toBe(pet);
    expect(runtime.writes).toHaveLength(3);
  });

  it('clears one layer and leaves the rest', () => {
    const runtime = fakeRuntime();
    setNpcLayer(runtime, 'pet:', [template('pet-breed:pug')], [instance('pet:1', 'pet-breed:pug')]);
    setNpcLayer(runtime, 'resident:', [template('resident:a')], [instance('r1', 'resident:a')]);
    clearNpcLayer(runtime, 'pet:');
    expect([...runtime.state().instances.keys()]).toEqual(['r1']);
    expect([...runtime.state().templates.keys()]).toEqual(['resident:a']);
    clearNpcLayer(runtime, 'pet:');
    expect(runtime.writes).toHaveLength(3);
  });

  it('keeps an instance the engine moved since the layer set it (moves replace the object in the store)', () => {
    const runtime = fakeRuntime();
    setNpcLayer(runtime, 'pet:', [template('pet-breed:pug')], [instance('pet:1', 'pet-breed:pug')]);
    const moved = { ...runtime.state().instances.get('pet:1')!, position: [4, 0, 2] as [number, number, number] };
    runtime.state().instances.set('pet:1', moved);
    setNpcLayer(runtime, 'resident:', [], [instance('r1', 'resident:a')]);
    expect(runtime.state().instances.get('pet:1')).toBe(moved);
  });
});

describe('ResidentsWorld with a pet on the island', () => {
  const item: CatalogItem = {
    id: 'mayor', kind: 'npc', label: '이장', emoji: '🙂', modelUrl: '/models/mayor.glb', thumbnailUrl: null, clips: ['idle'],
    source: 'factory', sourceRef: null, status: 'published', sortOrder: 1,
  };

  it('changing the residents and leaving the island never removes the pet', async () => {
    const runtime = fakeRuntime();
    const pet = instance('pet:1', 'pet-breed:pug');
    setNpcLayer(runtime, 'pet:', [template('pet-breed:pug')], [pet]);
    const residents = createResidentStore([{ id: 'r1', npc: 'mayor', name: '이장', greeting: '안녕', position: [1, 0, 1], rotation: 0 }]);
    const register = vi.fn(() => () => {});
    const fullRuntime = {
      ...runtime,
      interactablesStore: { getState: () => ({ register }) },
      npcSimulation: { getPose: () => undefined, greet: vi.fn(), face: vi.fn() },
      stateManager: { getActiveState: () => ({ position: { x: 0, y: 0, z: 0 } }) },
      buildingStore: { getState: () => ({ isInEditMode: () => false }) },
    } as unknown as Parameters<typeof ResidentsWorld>[0]['runtime'];
    const view = await mount(createElement(ResidentsWorld, { runtime: fullRuntime, residents, items: [item], greetings: createGreetingStore() }));
    expect([...runtime.state().instances.keys()].sort()).toEqual(['pet:1', 'r1']);

    residents.add({ npc: 'mayor', name: '둘째', greeting: '', position: [3, 0, 3], rotation: 0 });
    expect(runtime.state().instances.size).toBe(3);
    residents.remove('r1');
    expect(runtime.state().instances.has('r1')).toBe(false);
    expect(runtime.state().instances.get('pet:1')).toBe(pet);

    await view.unmount();
    expect([...runtime.state().instances.keys()]).toEqual(['pet:1']);
    expect([...runtime.state().templates.keys()]).toEqual(['pet-breed:pug']);
  });
});
