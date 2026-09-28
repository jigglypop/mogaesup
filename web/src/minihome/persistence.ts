import type { SaveAdapter, SaveBlob } from 'gaesup-world';

import { ApiRequestError } from '../api/client';
import { homeApi } from '../api/endpoints';

const MAIN_SLOT = 'main';

/**
 * The runtime's save storage for one home on the server. The owner's writes carry the revision they last read,
 * so a stale tab gets a 409 instead of overwriting a newer island; a visitor's adapter never writes.
 */
export function createHomeSaveAdapter(options: { username: string; worldId: string; writable: boolean }): SaveAdapter {
  let revision = 0;
  return {
    async read(slot) {
      if (slot !== MAIN_SLOT) return null;
      const world = await homeApi.world(options.username, options.worldId);
      revision = world?.revision ?? 0;
      return (world?.data as SaveBlob | undefined) ?? null;
    },
    async write(slot, blob) {
      if (!options.writable || slot !== MAIN_SLOT) return;
      const saved = await homeApi.saveWorld({ worldId: options.worldId, baseRevision: revision, data: blob });
      revision = saved.revision;
    },
    async list() {
      return revision > 0 ? [MAIN_SLOT] : [];
    },
    async remove() {},
  };
}

export const isSaveConflict = (error: unknown) => error instanceof ApiRequestError && error.status === 409;
