import { ApiRequestError, problemText } from '../api/client';
import { petApi } from '../api/endpoints';
import type { IslandPet, MyPet, PetBrainSave, SavedPetBrain } from '../api/types';
import { followSessionOwner, sessionBelongsTo } from '../auth/sessionWork';
import { PetBrain } from './brain/brain';
import { base64ToBytes } from './brain/codec';
import { loadPetGraph, PET_GRAPH_ID, type PetGraph } from './brain/graph';
import { breedInfo, PetController, type BreedInfo } from './controller';

/**
 * Keeping a pet: the owner's page saves what training changed (the brain's readout, drives, counts) every half minute
 * while something did, and as the page is hidden or left; another page's save in between stops this one (no more
 * learning, and `다시 불러오기`). `createPetHome` is the island page's pet: the published breeds, the pet (the owner's
 * with its brain, a visitor's as anyone sees it), and the owner's adopting, renaming, moving home and letting go.
 */

/** The server takes 30 saves in ten minutes; one every half minute leaves room for the page's last ones. */
export const SAVE_EVERY_MS = 30_000;
/** After `pet_saves_busy`, the next try waits this long. */
const BUSY_WAIT_MS = 120_000;

export type PetSaverOptions = {
  controller: PetController;
  ownerId: string;
  petId: string;
  revision: number;
  /** Another page saved over this one (`pet_changed`). */
  onConflict: () => void;
  save?: (body: PetBrainSave, options: { keepalive?: boolean }) => Promise<SavedPetBrain>;
  everyMs?: number;
};

export type PetSaver = {
  /** Saves now if anything changed; `keepalive` as the page goes. */
  flush: (options?: { keepalive?: boolean }) => Promise<void>;
  /** The revision the next save names. */
  readonly revision: number;
  stop: () => void;
};

export function createPetSaver({ controller, ownerId, petId, revision: first, onConflict, save = petApi.saveBrain, everyMs = SAVE_EVERY_MS }: PetSaverOptions): PetSaver {
  let revision = first;
  let stopped = false;
  let refused = false;
  let notBefore = 0;
  let writing: Promise<void> | null = null;
  const flush = async ({ keepalive = false }: { keepalive?: boolean } = {}): Promise<void> => {
    // Another flush waiting on the same save may have sent the next one meanwhile: that one is waited for too, so two
    // never go out naming the same revision (the second would be refused as another page's).
    while (writing) {
      await writing;
      if (!keepalive) return;
    }
    if (stopped || refused || Date.now() < notBefore || !controller.changed() || !sessionBelongsTo(ownerId)) return;
    const { body, mark } = controller.saveBody();
    writing = save({ ...body, revision, expectedOwnerId: ownerId, petId }, { keepalive })
      .then((saved) => {
        revision = saved.revision;
        controller.markSaved(mark);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiRequestError && error.status === 409 && error.code !== 'owner_changed') {
          refused = true;
          controller.setConditions({ conflict: true });
          onConflict();
        } else if (error instanceof ApiRequestError && error.status === 429) {
          notBefore = Date.now() + BUSY_WAIT_MS;
        }
        // Anything else (no answer, a proxy's error) tries again with the next round.
      })
      .finally(() => {
        writing = null;
      });
    await writing;
  };
  const timer = setInterval(() => void flush(), everyMs);
  const hidden = () => {
    if (document.visibilityState === 'hidden') void flush({ keepalive: true });
  };
  const leaving = () => void flush({ keepalive: true });
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', leaving);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('pagehide', leaving);
    unfollow();
  };
  // Someone else signing in on this browser ends this owner's saving.
  const unfollow = followSessionOwner(ownerId, stop);
  return {
    flush,
    get revision() {
      return revision;
    },
    stop,
  };
}

/** The brain the owner's page runs: the saved one, or a new one when there is none (or it is of another circuit). */
export function brainOf(graph: PetGraph, pet: MyPet): PetBrain {
  if (pet.brain && pet.graphId === PET_GRAPH_ID) {
    try {
      return PetBrain.decode(graph, pet.seed, base64ToBytes(pet.brain));
    } catch (error) {
      console.warn('[pet] saved brain unreadable; starting a new one', error);
    }
  }
  return PetBrain.create(graph, pet.seed);
}

export type PetHomeState = {
  phase: 'loading' | 'ready' | 'failed';
  /** Breeds to adopt from (the owner's page; empty for visitors). */
  breeds: readonly BreedInfo[];
  /** The island's pet as everyone sees it, or null. */
  pet: (IslandPet & { breedView: BreedInfo }) | null;
  /** The owner's running pet. */
  controller: PetController | null;
  /** Another page saved over this one; `reload` reads the pet again. */
  conflict: boolean;
  /** Why the last change failed, for the panel. */
  problem: string;
};

export type PetHome = {
  getState: () => PetHomeState;
  subscribe: (listener: () => void) => () => void;
  load: () => Promise<void>;
  adopt: (breedId: string, name: string, home: { x: number; z: number }) => Promise<boolean>;
  rename: (name: string) => Promise<boolean>;
  moveHome: (x: number, z: number) => Promise<boolean>;
  release: () => Promise<boolean>;
  /** After a conflict: the pet as stored now. */
  reload: () => Promise<void>;
  clearProblem: () => void;
  dispose: () => void;
};

export type PetHomeOptions = {
  username: string;
  ownerId: string;
  isOwner: boolean;
  /** The circuit (loaded once per page); a test passes its own. */
  graph?: () => Promise<PetGraph>;
  api?: Pick<typeof petApi, 'breeds' | 'island' | 'mine' | 'adopt' | 'update' | 'release' | 'saveBrain'>;
};

/** The island page's pet. */
export function createPetHome({ username, ownerId, isOwner, graph = () => loadPetGraph(), api = petApi }: PetHomeOptions): PetHome {
  let state: PetHomeState = { phase: 'loading', breeds: [], pet: null, controller: null, conflict: false, problem: '' };
  const listeners = new Set<() => void>();
  let saver: PetSaver | null = null;
  let disposed = false;
  let generation = 0;
  const set = (changes: Partial<PetHomeState>) => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener();
  };
  const stopRunning = () => {
    saver?.stop();
    saver = null;
    state.controller?.dispose();
  };
  const view = (pet: IslandPet): PetHomeState['pet'] => ({ ...pet, breedView: breedInfo(pet.breedInfo) });

  /** Runs the owner's pet: its brain from the stored readout, its saving. */
  const run = async (pet: MyPet, ticket: number): Promise<PetController | null> => {
    const brain = brainOf(await graph(), pet);
    if (disposed || ticket !== generation) return null;
    const controller = new PetController({ pet, breed: breedInfo(pet.breedInfo), brain });
    saver = createPetSaver({
      controller,
      ownerId,
      petId: pet.id,
      revision: pet.revision,
      onConflict: () => set({ conflict: true }),
      save: (body, options) => api.saveBrain(body, options),
    });
    return controller;
  };

  const load = async () => {
    const ticket = ++generation;
    stopRunning();
    set({ phase: 'loading', controller: null, conflict: false, problem: '' });
    try {
      if (isOwner) {
        const [{ breeds }, { pet }] = await Promise.all([api.breeds(), api.mine()]);
        const controller = pet ? await run(pet, ticket) : null;
        if (disposed || ticket !== generation) return;
        set({ phase: 'ready', breeds: breeds.map(breedInfo), pet: pet ? view(pet) : null, controller });
      } else {
        const { pet } = await api.island(username);
        if (disposed || ticket !== generation) return;
        set({ phase: 'ready', breeds: [], pet: pet ? view(pet) : null, controller: null });
      }
    } catch (error) {
      if (disposed || ticket !== generation) return;
      console.warn('[pet] could not load', error);
      set({ phase: 'failed', problem: problemText(error) });
    }
  };

  const change = async (work: () => Promise<void>): Promise<boolean> => {
    try {
      if (!sessionBelongsTo(ownerId)) throw new ApiRequestError(409, 'owner_changed', '계정이 바뀌어 저장을 중단했어요.');
      await work();
      if (!disposed) set({ problem: '' });
      return true;
    } catch (error) {
      if (!disposed) set({ problem: problemText(error) });
      return false;
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    adopt: (breedId, name, home) =>
      change(async () => {
        const { pet } = await api.adopt({ breedId, name, home, expectedOwnerId: ownerId });
        const ticket = ++generation;
        stopRunning();
        const controller = await run(pet, ticket);
        if (!disposed && ticket === generation) set({ pet: view(pet), controller, conflict: false });
      }),
    rename: (name) =>
      change(async () => {
        const current = state.pet;
        if (!current) return;
        const { pet } = await api.update({ name, expectedOwnerId: ownerId, petId: current.id });
        state.controller?.rename(pet.name);
        if (!disposed) set({ pet: view(pet) });
      }),
    moveHome: (x, z) =>
      change(async () => {
        const current = state.pet;
        if (!current) return;
        const { pet } = await api.update({ home: { x, z }, expectedOwnerId: ownerId, petId: current.id });
        state.controller?.moveHome(pet.home.x, pet.home.z);
        if (!disposed) set({ pet: view(pet) });
      }),
    release: () =>
      change(async () => {
        const current = state.pet;
        if (!current) return;
        await api.release({ expectedOwnerId: ownerId, petId: current.id });
        generation++;
        stopRunning();
        if (!disposed) set({ pet: null, controller: null, conflict: false });
      }),
    reload: load,
    clearProblem: () => set({ problem: '' }),
    dispose() {
      if (disposed) return;
      void saver?.flush({ keepalive: true });
      disposed = true;
      generation++;
      stopRunning();
      listeners.clear();
    },
  };
}

