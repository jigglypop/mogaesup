import type { RapierRigidBody } from '@react-three/rapier';

import type { SaveBlob } from 'gaesup-world';
import type { BuildingSerializedState } from 'gaesup-world/building';

import { homeApi } from '../../api/endpoints';
import { teleport } from '../../games/teleport';
import { placeResidents, templateOf, type IslandId } from '../islands';
import type { IslandStore } from '../islands/domain';
import { SPAWN } from '../islands/kit';
import { createHomeSaveAdapter } from '../persistence';
import type { ResidentStore } from '../residents';
import { MINIHOME_WORLD_ID } from '../world';
import type { IslandSaver } from './save';

/** Where the island an owner changed away from is kept, one deep: the next change replaces it. */
export const BEFORE_WORLD_ID = `${MINIHOME_WORLD_ID}-before`;

/** The island kept from before the last change, and when it was stored. */
export type KeptIsland = { blob: SaveBlob; updatedAt: string };

export type IslandBackup = {
  read: () => Promise<KeptIsland | null>;
  /** Keeps the stored island as the one from before; false when nothing is stored yet. */
  keep: () => Promise<boolean>;
  dispose: () => void;
};

/** The owner's kept island, through the same save route and checks as the island itself. */
export function createIslandBackup({ username, ownerId }: { username: string; ownerId: string }): IslandBackup {
  const adapter = createHomeSaveAdapter({ username, ownerId, worldId: BEFORE_WORLD_ID, writable: true });
  return {
    async read() {
      const kept = await homeApi.world(username, BEFORE_WORLD_ID);
      return kept ? { blob: kept.data as SaveBlob, updatedAt: kept.updatedAt } : null;
    },
    async keep() {
      const stored = await homeApi.world(username, MINIHOME_WORLD_ID);
      if (!stored) return false;
      await adapter.refreshRevision();
      await adapter.write('main', stored.data as SaveBlob);
      return true;
    },
    dispose: () => adapter.dispose(),
  };
}

/** A change that did not happen, in words for the owner. */
export class IslandChangeError extends Error {
  override name = 'IslandChangeError';
}

export type IslandChangeContext = {
  saver: Pick<IslandSaver, 'flush' | 'save'>;
  backup: Pick<IslandBackup, 'read' | 'keep'>;
  runtime: {
    buildingStore: { getState: () => { hydrate: (state: BuildingSerializedState) => void } };
    save: { createBlob: () => SaveBlob; hydrateBlob: (blob: SaveBlob) => boolean };
  };
  island: IslandStore;
  residents: ResidentStore;
  /** Undo starts over from the new island: changing islands is undone by going back to the kept one. */
  history: { stop: () => void; start: () => void };
  /** Puts the player (and a decorating view) where the island starts. */
  arrive: () => void;
};

const NOT_SAVED = '지금 섬을 저장하지 못해 바꾸지 않았어요.';
const NOT_KEPT = '이전 섬을 보관하지 못해 바꾸지 않았어요.';

async function keep(ctx: IslandChangeContext) {
  try {
    await ctx.backup.keep();
  } catch {
    throw new IslandChangeError(NOT_KEPT);
  }
}

/**
 * Turns the island into a fresh `id`: unsaved edits are saved first, the stored island is kept as the one from before,
 * then the template's island, kind and resident spots go in, and the result is saved. Nothing changes when the first
 * two fail. Resolves to whether the new island was saved (the saver retries and shows why when it was not).
 */
export async function changeIsland(ctx: IslandChangeContext, id: IslandId): Promise<boolean> {
  if (!(await ctx.saver.flush())) throw new IslandChangeError(NOT_SAVED);
  await keep(ctx);
  const template = templateOf(id);
  ctx.history.stop();
  try {
    ctx.runtime.buildingStore.getState().hydrate(template.build());
    ctx.island.set(id);
    ctx.residents.replace(placeResidents(ctx.residents.getState(), template));
  } finally {
    ctx.history.start();
  }
  ctx.arrive();
  return ctx.saver.save();
}

/**
 * Goes back to the kept island, keeping the one left as the island from before: the two trade places. The kept island
 * loads the way a stored one does; when keeping the current one fails, the island goes back to it.
 */
export async function restoreIsland(ctx: IslandChangeContext): Promise<boolean> {
  if (!(await ctx.saver.flush())) throw new IslandChangeError(NOT_SAVED);
  let kept: KeptIsland | null;
  try {
    kept = await ctx.backup.read();
  } catch {
    throw new IslandChangeError('이전 섬을 불러오지 못했어요.');
  }
  if (!kept) throw new IslandChangeError('이전 섬이 없어요.');
  const current = ctx.runtime.save.createBlob();
  const apply = (blob: SaveBlob) => {
    ctx.history.stop();
    try {
      return ctx.runtime.save.hydrateBlob(blob);
    } finally {
      ctx.history.start();
    }
  };
  let applied = false;
  try {
    applied = apply(kept.blob);
  } catch {
    // The engine put the island back as it was.
  }
  if (!applied) throw new IslandChangeError('이전 섬을 불러오지 못했어요.');
  try {
    await keep(ctx);
  } catch (error) {
    apply(current);
    throw error;
  }
  ctx.arrive();
  return ctx.saver.save();
}

/** The player at the island's start, and a decorating view looking there. */
export function arriveAtStart(body: RapierRigidBody | null, view?: { setPivot: (x: number, z: number) => void } | null) {
  teleport(body, [SPAWN[0], 0, SPAWN[2]]);
  view?.setPivot(SPAWN[0], SPAWN[2]);
}
