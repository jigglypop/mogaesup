import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminPetBreed } from '../../../api/types';
import { mount } from '../../../__tests__/mount';

const pets = vi.hoisted(() => ({
  adminBreeds: vi.fn(),
  patchBreed: vi.fn(),
  registerBreed: vi.fn(),
}));
vi.mock('../../../api/endpoints', () => ({ petApi: pets }));

import breedList from '../../../pets/breeds.json';
import { PetBreeds } from '../PetBreeds';

const breed = (changes: Partial<AdminPetBreed> = {}): AdminPetBreed => ({
  id: 'golden-retriever', label: '골든리트리버', emoji: '🐶', modelUrl: '/gltf/pets/golden-retriever.glb',
  thumbnailUrl: '/gltf/pets/golden-retriever.webp', clips: ['idle'], heightM: 0.55, species: 'dog', status: 'published',
  sortOrder: 1, source: 'builtin', sourceRef: null, pets: 3, createdAt: '', updatedAt: '', ...changes,
});
const settle = () => act(async () => void (await Promise.resolve()));

afterEach(() => vi.clearAllMocks());

describe('PetBreeds', () => {
  it('lists breeds with their status and pets, and moves one between public, draft and retired', async () => {
    pets.adminBreeds.mockResolvedValue({ breeds: [breed()] });
    pets.patchBreed.mockImplementation(async (id: string, body: Partial<AdminPetBreed>) => breed({ id, ...body }));
    const onNotice = vi.fn();
    const view = await mount(<PetBreeds onNotice={onNotice} />);
    await settle();
    const row = view.container.querySelector('tbody tr')!;
    expect(row.textContent).toContain('골든리트리버');
    expect(row.textContent).toContain('공개');
    const retire = [...row.querySelectorAll('button')].find((button) => button.textContent === '내리기')!;
    await act(async () => retire.click());
    expect(pets.patchBreed).toHaveBeenCalledWith('golden-retriever', { status: 'retired' });
    expect(row.querySelector('.mg-badge')?.textContent).toBe('내림');
    expect(onNotice).toHaveBeenCalledWith({ tone: 'ok', text: '골든리트리버: 내림' });
    await view.unmount();
  });

  it('adds a dog the app ships that is not a breed yet, as a draft', async () => {
    const listed = breedList.slice(1).map((shipped) => breed({ id: shipped.slug, label: shipped.name }));
    pets.adminBreeds.mockResolvedValue({ breeds: listed });
    pets.registerBreed.mockImplementation(async (body: { id: string; label: string }) => breed({ ...body, status: 'draft' }));
    const view = await mount(<PetBreeds onNotice={vi.fn()} />);
    await settle();
    const first = breedList[0]!;
    const add = [...view.container.querySelectorAll<HTMLButtonElement>('.mg-admin-pets-shipped button')];
    expect(add.map((button) => button.textContent?.trim())).toEqual([first.name]);
    await act(async () => add[0]!.click());
    expect(pets.registerBreed).toHaveBeenCalledWith({
      id: first.slug, label: first.name, modelUrl: first.model, thumbnailUrl: first.thumbnail,
      clips: Object.keys(first.clips), heightM: first.height_m, sortOrder: first.order,
    });
    expect(view.container.querySelector('.mg-admin-pets-shipped')).toBeNull();
    await view.unmount();
  });
});
