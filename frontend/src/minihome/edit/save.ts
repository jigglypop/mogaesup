import type { SaveSystem } from 'gaesup-world';

import { ApiRequestError, ApiTimeoutError } from '../../api/client';
import { IslandTooLargeError, MAX_ISLAND_BYTES } from '../persistence';

type SaveProblemKind = 'tooLarge' | 'invalid' | 'auth' | 'network' | 'server';
export type SaveProblem = { kind: SaveProblemKind; message: string };

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
const LIMIT = megabytes(MAX_ISLAND_BYTES).replace('.0', '');

/** What went wrong with a save, in words for the owner; a revision conflict is its own case. */
export function describeSaveError(error: unknown, bytes?: number | null): SaveProblem | 'conflict' {
  if (error instanceof IslandTooLargeError || (error instanceof ApiRequestError && error.status === 413)) {
    const size = error instanceof IslandTooLargeError ? error.bytes : bytes;
    return {
      kind: 'tooLarge',
      message: `섬이 너무 커요${size ? ` (${megabytes(size)})` : ''}. 한 섬은 ${LIMIT}까지 저장할 수 있어요. 물건이나 바닥을 조금 줄여 주세요.`,
    };
  }
  if (error instanceof ApiRequestError) {
    if (error.status === 409) return 'conflict';
    if (error.status === 422) {
      return { kind: 'invalid', message: '섬에 저장할 수 없는 내용이 섞여 있어요. 최근에 놓은 물건을 치우고 다시 저장해 주세요.' };
    }
    if (error.status === 401) return { kind: 'auth', message: '로그인이 풀렸어요. 다시 로그인한 뒤 저장해 주세요.' };
    if (error.status === 403) return { kind: 'auth', message: '이 섬을 저장할 권한이 없어요.' };
    return { kind: 'server', message: '서버가 잠시 대답하지 않아요. 조금 뒤에 다시 저장해 볼게요.' };
  }
  // fetch rejects with a TypeError when the request never reached the server.
  if (error instanceof TypeError) return { kind: 'network', message: '인터넷 연결이 끊겼어요. 연결되면 다시 저장해 볼게요.' };
  if (error instanceof ApiTimeoutError) return { kind: 'network', message: '서버가 대답하지 않아요. 곧 다시 저장해 볼게요.' };
  return { kind: 'server', message: '섬을 저장하지 못했어요. 조금 뒤에 다시 저장해 볼게요.' };
}

function describeLoadError(error: unknown): SaveProblem {
  if (error instanceof ApiRequestError && error.status < 500) return { kind: 'auth', message: `섬을 불러오지 못했어요. ${error.message}` };
  if (error instanceof TypeError) return { kind: 'network', message: '섬을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 불러와 주세요.' };
  if (error instanceof ApiTimeoutError) return { kind: 'network', message: '섬을 불러오지 못했어요. 서버가 대답하지 않아요. 다시 불러와 주세요.' };
  return { kind: 'server', message: '섬을 불러오지 못했어요. 조금 뒤에 다시 불러와 주세요.' };
}

/** A clock time as the island's time chip shows it: 오후 3:07. */
export function clock(time: number): string {
  const date = new Date(time);
  const hour = date.getHours();
  return `${hour < 12 ? '오전' : '오후'} ${hour % 12 === 0 ? 12 : hour % 12}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export const sizeText = (bytes: number) => megabytes(bytes);
export const SIZE_LIMIT_TEXT = LIMIT;

type SaveStatus = { tone: 'good' | 'busy' | 'warn' | 'bad'; label: string; detail: string };

/** The one-line save status the decorating bar shows, and what it means. */
export function describeStatus(state: SaverState): SaveStatus {
  if (state.phase === 'loading') return { tone: 'busy', label: '불러오는 중', detail: '저장된 섬을 불러오고 있어요. 다 불러오면 꾸밀 수 있어요.' };
  if (state.phase === 'loadFailed') {
    return { tone: 'bad', label: '불러오지 못함', detail: state.problem?.message ?? '섬을 불러오지 못했어요. 다시 불러와 주세요.' };
  }
  if (state.conflict) {
    return { tone: 'bad', label: '다른 곳에서 저장됨', detail: '다른 탭이나 기기에서 이 섬을 먼저 저장했어요. 어느 쪽을 남길지 골라 주세요.' };
  }
  if (state.saving) return { tone: 'busy', label: '저장 중…', detail: '섬을 저장하고 있어요.' };
  if (state.problem) return { tone: 'bad', label: '저장 못 함', detail: state.problem.message };
  if (state.dirty) return { tone: 'warn', label: '저장 안 된 변경', detail: '손을 멈추면 곧 자동으로 저장돼요. 바로 저장하려면 Ctrl+S를 눌러요.' };
  return {
    tone: 'good',
    label: '저장됨',
    detail: state.lastSavedAt ? `${clock(state.lastSavedAt)}에 저장했어요.` : '불러온 뒤로 바뀐 것이 없어요.',
  };
}

export type SaverState = {
  /** `loading` until the stored island is applied; nothing saves before, so a half-loaded island never overwrites it. */
  phase: 'loading' | 'loadFailed' | 'ready';
  saving: boolean;
  /** Something changed since the island was loaded or last saved. */
  dirty: boolean;
  /** Another tab or device saved first; saving waits for the owner to choose whose island wins. */
  conflict: boolean;
  problem: SaveProblem | null;
  lastSavedAt: number | null;
  /** Size of the last island sent, in bytes. */
  bytes: number | null;
};

export type IslandSaver = {
  getState: () => SaverState;
  subscribe: (listener: () => void) => () => void;
  /** Reads the stored island into the world; call once the runtime is set up. */
  load: () => Promise<boolean>;
  /** Saves now, changed or not (the 저장 button). */
  save: () => Promise<boolean>;
  /** Saves when there is something unsaved that saving can fix (leaving, hiding the page, the autosave timer). */
  flush: () => Promise<boolean>;
  /** After a conflict: takes the stored island's latest revision and saves this one over it. */
  overwrite: () => Promise<boolean>;
  /** After a conflict: drops local changes and loads the stored island. */
  reloadLatest: () => Promise<boolean>;
  /** Tells the saver the world may have changed: updates `dirty` and times the next autosave. */
  changed: () => void;
  dispose: () => void;
};

export type IslandSaverOptions = {
  system: Pick<SaveSystem, 'save' | 'load' | 'getBindings'>;
  /** `revision`: the stored island's, 0 while nothing is stored. */
  adapter: { refreshRevision: () => Promise<void>; readonly lastBytes: number | null; readonly revision: number };
  writable: boolean;
  /** Autosave this long after the last change... */
  idleMs?: number;
  /** ...but no later than this after the first unsaved one. */
  maxWaitMs?: number;
  /** Waits before retrying a save that failed on the network or the server, one per failure in a row. */
  retryMs?: readonly number[];
  now?: () => number;
};

type Revisions = Map<string, number>;
const differs = (a: Revisions, b: Revisions) => a.size !== b.size || [...a].some(([key, value]) => b.get(key) !== value);

/**
 * Saving one island: tracks what changed since the last load or save by the runtime's save revisions, autosaves after
 * a pause in editing, retries network failures, and holds still through a conflict until the owner resolves it.
 */
export function createIslandSaver({
  system,
  adapter,
  writable,
  idleMs = 10_000,
  maxWaitMs = 60_000,
  retryMs = [10_000, 30_000, 60_000, 120_000],
  now = Date.now,
}: IslandSaverOptions): IslandSaver {
  let state: SaverState = { phase: 'loading', saving: false, dirty: false, conflict: false, problem: null, lastSavedAt: null, bytes: null };
  const listeners = new Set<() => void>();
  /** Domain revisions the server holds, from the last load or save. */
  let saved: Revisions | null = null;
  /** Revisions a save failed at for a reason retrying the same island cannot fix (too large, refused). */
  let failed: Revisions | null = null;
  let firstDirtyAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let inflight: Promise<boolean> | null = null;
  let again = false;
  let disposed = false;
  /** Counts loads, so one that a newer load has overtaken leaves the state to it. */
  let loads = 0;

  const set = (patch: Partial<SaverState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const revisions = (): Revisions => {
    const map: Revisions = new Map();
    for (const binding of system.getBindings()) {
      const revision = binding.revision?.();
      if (revision !== undefined) map.set(binding.key, revision);
    }
    return map;
  };
  const isDirty = () => saved !== null && differs(revisions(), saved);
  const stuck = () => failed !== null && !differs(revisions(), failed);
  const stopTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const stopRetry = () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const schedule = () => {
    // A save that failed waits out its own retry delay; editing meanwhile does not shorten it.
    if (disposed || !writable || state.phase !== 'ready' || state.conflict || !state.dirty || stuck() || retryTimer !== undefined) return;
    const at = now();
    firstDirtyAt ??= at;
    const due = Math.min(at + idleMs, firstDirtyAt + maxWaitMs);
    stopTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, Math.max(0, due - at));
  };

  const attempt = (): Promise<boolean> => {
    const captured = revisions();
    set({ saving: true });
    // The runtime serializes synchronously inside save(), so `captured` names exactly what this write holds.
    return system.save().then(
      () => {
        saved = captured;
        failed = null;
        retries = 0;
        firstDirtyAt = null;
        set({ saving: false, problem: null, lastSavedAt: now(), bytes: adapter.lastBytes, dirty: isDirty() });
        return true;
      },
      (error: unknown) => {
        // The wait for the next autosave starts from the next edit, not from the one this attempt was for.
        firstDirtyAt = null;
        const problem = describeSaveError(error, adapter.lastBytes);
        if (problem === 'conflict') {
          set({ saving: false, conflict: true, dirty: isDirty() });
          return false;
        }
        const retryable = problem.kind === 'network' || problem.kind === 'server';
        failed = retryable ? null : captured;
        set({ saving: false, problem, bytes: adapter.lastBytes, dirty: isDirty() });
        if (retryable && !disposed) {
          const delay = retryMs[Math.min(retries, retryMs.length - 1)] ?? 60_000;
          retries++;
          stopRetry();
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            void flush();
          }, delay);
        }
        return false;
      },
    );
  };

  const save = (): Promise<boolean> => {
    if (!writable || state.phase !== 'ready' || state.conflict) return Promise.resolve(false);
    if (inflight) {
      again = true;
      return inflight;
    }
    stopTimer();
    stopRetry();
    const run = attempt().finally(() => {
      inflight = null;
      const next = again;
      again = false;
      if (next && isDirty()) void save();
      else schedule();
    });
    inflight = run;
    return run;
  };

  const flush = (): Promise<boolean> => {
    if (state.phase !== 'ready' || !saved) return Promise.resolve(false);
    const dirty = isDirty();
    if (dirty !== state.dirty) set({ dirty });
    if (!dirty) return Promise.resolve(true);
    if (stuck()) return Promise.resolve(false);
    return save();
  };

  const load = async (): Promise<boolean> => {
    const mine = ++loads;
    stopTimer();
    stopRetry();
    saved = null;
    set({ phase: 'loading', problem: null });
    let applied: boolean;
    try {
      applied = await system.load();
    } catch (error) {
      if (mine === loads) set({ phase: 'loadFailed', problem: describeLoadError(error) });
      return false;
    }
    if (mine !== loads) return false;
    // Nothing applied means either nothing is stored yet (the first save creates it), or the restore was cancelled while
    // an island is stored. This island is then the village the runtime starts with, and saving it would replace theirs.
    if (!applied && adapter.revision > 0) {
      set({ phase: 'loadFailed', problem: { kind: 'server', message: '섬을 불러오지 못했어요. 다시 불러와 주세요.' } });
      return false;
    }
    saved = revisions();
    failed = null;
    retries = 0;
    firstDirtyAt = null;
    set({ phase: 'ready', dirty: false, conflict: false, problem: null });
    return true;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    save,
    flush,
    async overwrite() {
      if (!writable) return false;
      try {
        await adapter.refreshRevision();
      } catch (error) {
        const problem = describeSaveError(error);
        if (problem !== 'conflict') set({ problem });
        return false;
      }
      set({ conflict: false });
      return save();
    },
    async reloadLatest() {
      if (inflight) await inflight;
      return load();
    },
    changed() {
      if (disposed || state.phase !== 'ready' || !saved) return;
      const dirty = isDirty();
      if (dirty !== state.dirty) set({ dirty });
      if (!dirty) {
        firstDirtyAt = null;
        stopTimer();
      } else if (!state.saving) schedule();
    },
    dispose() {
      disposed = true;
      stopTimer();
      stopRetry();
    },
  };
}
