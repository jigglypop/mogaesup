import type { SaveAdapter, SaveBlob } from 'gaesup-world';

import { ApiRequestError, ApiTimeoutError } from '../api/client';
import { homeApi } from '../api/endpoints';
import { followSessionOwner } from '../auth/sessionWork';

const MAIN_SLOT = 'main';
/** The server's limit on one island's save envelope (`MAX_WORLD_BYTES`). */
export const MAX_ISLAND_BYTES = 2 * 1024 * 1024;
/** Writes whose answer was lost that are kept to compare with the stored island; each is up to 2MB. */
const UNANSWERED_KEPT = 3;

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

/** Another tab or device saved over the revision this write was based on. */
const isSaveConflict = (error: unknown) => error instanceof ApiRequestError && error.status === 409 && error.code !== 'owner_changed';
/** A write that may or may not have been stored: the answer never came, or a proxy answered for the server. */
const answerLost = (error: unknown) =>
  error instanceof TypeError || error instanceof ApiTimeoutError || (error instanceof ApiRequestError && error.status >= 500);

/** JSON values equal as the server keeps them: key order aside (it stores the island as jsonb). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, index) => sameJson(value, other[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

/** A save envelope without its `savedAt`, which is stamped anew on every save. */
const islandOf = (envelope: object) => {
  const island: Record<string, unknown> = { ...envelope };
  delete island['savedAt'];
  return island;
};

/** Whether the island sent as `sent` is the one stored. */
function sameIsland(sent: string, stored: unknown): boolean {
  if (typeof stored !== 'object' || stored === null) return false;
  return sameJson(islandOf(JSON.parse(sent) as object), islandOf(stored));
}

/**
 * The runtime's save storage for one home on the server. The owner's writes carry the revision they last read,
 * so a stale tab gets a 409 instead of overwriting a newer island; a visitor's adapter never writes. A write whose answer
 * was lost may have been stored all the same: when the next one meets a conflict and the stored island is one this
 * adapter sent, the conflict is with itself, so it takes that revision and carries on.
 */
export function createHomeSaveAdapter(options: { username: string; ownerId: string; worldId: string; writable: boolean }): HomeSaveAdapter {
  let revision = 0;
  let lastBytes: number | null = null;
  /** Islands sent since the last answered write whose answers never came, newest last, as sent. */
  let unanswered: string[] = [];
  const controller = new AbortController();
  const stopWatching = options.writable ? followSessionOwner(options.ownerId, () => controller.abort()) : () => {};
  const put = async (blob: SaveBlob, text: string) => {
    try {
      const saved = await homeApi.saveWorld(
        { expectedOwnerId: options.ownerId, worldId: options.worldId, baseRevision: revision, data: blob },
        controller.signal,
      );
      revision = saved.revision;
      unanswered = [];
    } catch (error) {
      if (answerLost(error)) unanswered = [...unanswered, text].slice(-UNANSWERED_KEPT);
      throw error;
    }
  };
  return {
    dispose() { stopWatching(); controller.abort(); },
    async read(slot) {
      if (slot !== MAIN_SLOT) return null;
      const world = await homeApi.world(options.username, options.worldId, controller.signal);
      revision = world?.revision ?? 0;
      unanswered = [];
      return (world?.data as SaveBlob | undefined) ?? null;
    },
    async write(slot, blob) {
      if (!options.writable || slot !== MAIN_SLOT) return;
      if (controller.signal.aborted) throw new ApiRequestError(409, 'owner_changed', '계정이 바뀌어 저장을 중단했어요.');
      const text = JSON.stringify(blob);
      lastBytes = byteLength(text);
      if (lastBytes > MAX_ISLAND_BYTES) throw new IslandTooLargeError(lastBytes);
      try {
        await put(blob, text);
      } catch (error) {
        if (!isSaveConflict(error) || unanswered.length === 0) throw error;
        const lost = unanswered;
        const world = await homeApi.world(options.username, options.worldId, controller.signal);
        if (!world || !lost.some((sent) => sameIsland(sent, world.data))) throw error;
        // One of the writes that went unanswered was stored: build on it.
        revision = world.revision;
        unanswered = [];
        if (!sameIsland(text, world.data)) await put(blob, text);
      }
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
