import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import type { IslandPet, MyPet, PetBreed } from '../../api/types';
import { setSessionOwner } from '../../auth/sessionWork';
import { PetBrain } from '../brain/brain';
import { bytesToBase64 } from '../brain/codec';
import { parsePetGraph } from '../brain/graph';
import { breedInfo, PetController } from '../controller';
import { brainOf, createPetHome, createPetSaver } from '../persistence';

const graph = parsePetGraph(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../brain/malecns-dna02-128.json'), 'utf8')));
const OWNER = '11111111-2222-4333-8444-555555555555';
const BREED: PetBreed = {
  id: 'pug', label: '퍼그', emoji: '🐶', modelUrl: '/gltf/pets/pug.glb', thumbnailUrl: '/gltf/pets/pug.webp',
  clips: ['idle', 'walk', 'run', 'sit', 'lie', 'sit_hold', 'lie_hold', 'bark', 'jump'], heightM: 0.55,
};
const myPet = (changes: Partial<MyPet> = {}): MyPet => ({
  id: '7d3c1f9e-2b4a-4c8e-9f10-123456789abc', name: '초코', breed: 'pug', breedInfo: BREED, home: { x: 1, z: 2 }, seed: 99,
  graphId: 'malecns-v1.0-dna02-neighborhood-128', model: 'pet-brain-v1', brain: null, drives: {}, stats: {}, revision: 3,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...changes,
});
const controllerFor = (pet = myPet()) =>
  new PetController({ pet, breed: breedInfo(BREED), brain: PetBrain.create(graph, pet.seed), idle: (work) => work() });

beforeEach(() => {
  vi.useFakeTimers();
  setSessionOwner(OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  setSessionOwner(null);
});

describe('createPetSaver', () => {
  it('saves every half minute while something changed, naming the revision it has', async () => {
    const controller = controllerFor();
    const save = vi.fn(async (body: { revision: number }) => ({ revision: body.revision + 1, updatedAt: 'now' }));
    const saver = createPetSaver({ controller, ownerId: OWNER, petId: controller.pet.id, revision: 3, onConflict: vi.fn(), save });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).not.toHaveBeenCalled();
    controller.command('sit');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({ revision: 3, expectedOwnerId: OWNER, petId: controller.pet.id });
    expect(saver.revision).toBe(4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).toHaveBeenCalledTimes(1);
    controller.feedback('praise');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save.mock.calls[1]![0]).toMatchObject({ revision: 4 });
    saver.stop();
    controller.command('down');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('saves with keepalive as the page is hidden or left', async () => {
    const controller = controllerFor();
    const save = vi.fn(async () => ({ revision: 4, updatedAt: 'now' }));
    const saver = createPetSaver({ controller, ownerId: OWNER, petId: controller.pet.id, revision: 3, onConflict: vi.fn(), save });
    controller.command('sit');
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledWith(expect.anything(), { keepalive: true });
    saver.stop();
  });

  it('stops learning and saving once another page saved over it, and waits after too many saves', async () => {
    const controller = controllerFor();
    const onConflict = vi.fn();
    const save = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError(429, 'pet_saves_busy', '저장이 너무 잦아요.'))
      .mockRejectedValueOnce(new ApiRequestError(409, 'pet_changed', '다른 곳에서 펫이 바뀌었어요.'));
    const saver = createPetSaver({ controller, ownerId: OWNER, petId: controller.pet.id, revision: 3, onConflict, save });
    controller.command('sit');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(controller.status().command).toBeNull();
    controller.feedback('praise');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(save).toHaveBeenCalledTimes(2);
    saver.stop();
  });

  it('never saves for another account signed in on this browser', async () => {
    const controller = controllerFor();
    const save = vi.fn(async () => ({ revision: 4, updatedAt: 'now' }));
    const saver = createPetSaver({ controller, ownerId: OWNER, petId: controller.pet.id, revision: 3, onConflict: vi.fn(), save });
    controller.command('sit');
    setSessionOwner('someone-else');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).not.toHaveBeenCalled();
    saver.stop();
  });
});

describe('brainOf', () => {
  it('reads the saved brain, and starts anew from one it cannot read', () => {
    const trained = PetBrain.create(graph, 99);
    const saved = myPet({ brain: bytesToBase64(trained.encode()) });
    expect(Array.from(brainOf(graph, saved).encode())).toEqual(Array.from(trained.encode()));
    const broken = myPet({ brain: bytesToBase64(new Uint8Array(5184)) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(brainOf(graph, broken).updates).toBe(0);
    expect(warn).toHaveBeenCalled();
    expect(brainOf(graph, myPet({ graphId: 'another-circuit', brain: saved.brain })).updates).toBe(0);
  });
});

describe('createPetHome', () => {
  const api = () => ({
    breeds: vi.fn(async () => ({ breeds: [BREED] })),
    island: vi.fn(async () => ({ pet: null as IslandPet | null })),
    mine: vi.fn(async () => ({ pet: null as MyPet | null })),
    adopt: vi.fn(async () => ({ pet: myPet() })),
    update: vi.fn(async (body: { name?: string }) => ({ pet: myPet({ name: body.name ?? '초코' }) })),
    release: vi.fn(async () => undefined),
    saveBrain: vi.fn(async () => ({ revision: 4, updatedAt: 'now' })),
  });

  it('gives the owner the breeds, adopts beside them, renames and lets the pet go', async () => {
    const calls = api();
    const home = createPetHome({ username: 'mo', ownerId: OWNER, isOwner: true, graph: async () => graph, api: calls });
    await home.load();
    expect(home.getState()).toMatchObject({ phase: 'ready', pet: null, controller: null });
    expect(home.getState().breeds.map((breed) => breed.id)).toEqual(['pug']);
    expect(await home.adopt('pug', '초코', { x: 3, z: 4 })).toBe(true);
    expect(calls.adopt).toHaveBeenCalledWith({ breedId: 'pug', name: '초코', home: { x: 3, z: 4 }, expectedOwnerId: OWNER });
    const controller = home.getState().controller!;
    expect(controller.name).toBe('초코');
    expect(await home.rename('보리')).toBe(true);
    expect(calls.update).toHaveBeenCalledWith({ name: '보리', expectedOwnerId: OWNER, petId: myPet().id });
    expect(controller.name).toBe('보리');
    expect(await home.release()).toBe(true);
    expect(home.getState()).toMatchObject({ pet: null, controller: null });
    home.dispose();
  });

  it('shows the problem when a change is refused', async () => {
    const calls = api();
    calls.adopt.mockRejectedValueOnce(new ApiRequestError(409, 'pet_exists', '이미 함께 지내는 펫이 있어요.'));
    const home = createPetHome({ username: 'mo', ownerId: OWNER, isOwner: true, graph: async () => graph, api: calls });
    await home.load();
    expect(await home.adopt('pug', '초코', { x: 0, z: 0 })).toBe(false);
    expect(home.getState().problem).toBe('이미 함께 지내는 펫이 있어요.');
    home.dispose();
  });

  it('gives a visitor the island’s pet only, without running it', async () => {
    const calls = api();
    calls.island.mockResolvedValueOnce({ pet: { id: myPet().id, name: '초코', breed: 'pug', breedInfo: BREED, home: { x: 1, z: 2 } } });
    const home = createPetHome({ username: 'mo', ownerId: OWNER, isOwner: false, graph: async () => graph, api: calls });
    await home.load();
    expect(calls.island).toHaveBeenCalledWith('mo');
    expect(calls.mine).not.toHaveBeenCalled();
    expect(home.getState()).toMatchObject({ phase: 'ready', controller: null, breeds: [] });
    expect(home.getState().pet?.breedView.strideSpeed).toBeGreaterThan(0);
    home.dispose();
  });

  it('reads the pet again after a conflict', async () => {
    const calls = api();
    calls.mine.mockResolvedValue({ pet: myPet() });
    calls.saveBrain.mockRejectedValue(new ApiRequestError(409, 'pet_changed', '다른 곳에서 펫이 바뀌었어요.'));
    const home = createPetHome({ username: 'mo', ownerId: OWNER, isOwner: true, graph: async () => graph, api: calls });
    await home.load();
    const first = home.getState().controller!;
    first.command('sit');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(home.getState().conflict).toBe(true);
    await home.reload();
    expect(home.getState().conflict).toBe(false);
    expect(home.getState().controller).not.toBe(first);
    home.dispose();
  });
});
