import type { SaveAdapter, SaveBlob } from 'gaesup-world';

import { ApiRequestError } from '../api/client';
import { homeApi } from '../api/endpoints';
import { followSessionOwner } from '../auth/sessionWork';

const MAIN_SLOT = 'main';
/** The server's limit on one island's save envelope (`MAX_WORLD_BYTES`). */
export const MAX_ISLAND_BYTES = 2 * 1024 * 1024;

/** An island over the server's size limit, caught before it is sent. */
export class IslandTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super('섬이 너무 커요');
    this.name = 'IslandTooLargeError';
  }
}

type HomeSaveAdapter = SaveAdapter & {
  dispose: () => void;
  /** Learns the stored island's latest revision without applying it, so the next write replaces that revision. */
  refreshRevision: () => Promise<void>;
  /** The size of the last island this adapter wrote or tried to write, in bytes. */
  readonly lastBytes: number | null;
  /** The stored island's revision as last read or written; 0 while nothing is stored. */
  readonly revision: number;
};

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/**
 * The runtime's save storage for one home on the server. The owner's writes carry the revision they last read,
 * so a stale tab gets a 409 instead of overwriting a newer island; a visitor's adapter never writes.
 */
export function createHomeSaveAdapter(options: { username: string; ownerId: string; worldId: string; writable: boolean }): HomeSaveAdapter {
  let revision = 0;
  let lastBytes: number | null = null;
  const controller = new AbortController();
  const stopWatching = options.writable ? followSessionOwner(options.ownerId, () => controller.abort()) : () => {};
  return {
    dispose() { stopWatching(); controller.abort(); },
    async read(slot) {
      if (slot !== MAIN_SLOT) return null;
      const world = await homeApi.world(options.username, options.worldId, controller.signal);
      revision = world?.revision ?? 0;
      return (world?.data as SaveBlob | undefined) ?? null;
    },
    async write(slot, blob) {
      if (!options.writable || slot !== MAIN_SLOT) return;
      if (controller.signal.aborted) throw new ApiRequestError(409, 'owner_changed', '계정이 바뀌어 저장을 중단했어요.');
      lastBytes = byteLength(JSON.stringify(blob));
      if (lastBytes > MAX_ISLAND_BYTES) throw new IslandTooLargeError(lastBytes);
      const saved = await homeApi.saveWorld({ expectedOwnerId: options.ownerId, worldId: options.worldId, baseRevision: revision, data: blob }, controller.signal);
      revision = saved.revision;
    },
    async refreshRevision() {
      const world = await homeApi.world(options.username, options.worldId, controller.signal);
      revision = world?.revision ?? 0;
    },
    get lastBytes() {
      return lastBytes;
    },
    get revision() {
      return revision;
    },
    async list() {
      return revision > 0 ? [MAIN_SLOT] : [];
    },
    async remove() {},
  };
}

export const isSaveConflict = (error: unknown) => error instanceof ApiRequestError && error.status === 409 && error.code !== 'owner_changed';
