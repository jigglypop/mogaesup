import { deadline } from '../api/client';
import { reportStudio } from '../api/studioSleep';
import { expireSession, sessionEpoch } from '../auth/sessionWork';

type Part = { node_index: number; role: string; name?: string };
type Operation = { id: string; action_id: string; status: string; error: { code: string; message: string } | null };
type Character = {
  id: string; name: string; revision: string; height_meters: number | null;
  pipeline_status: string; rig_origin: string; model_id: string | null; model_sha256: string | null;
  provider: { stage: string | null; status: string | null; progress: number | null; task_id: string | null; http_status: number | null };
  operation: Operation | null;
  motion_pack: { status: string | null; submitted_tasks: number; max_new_tasks: number | null;
    clips: Record<string, { action_id: number | null; source: string }>;
    tasks: Record<string, { status: string; task_id: string | null; progress: number | null }> };
  problems: { code: string; message: string }[];
  next_actions: { id: string; label: string; enabled: boolean; reason: string | null; external_mutation: boolean }[];
  artifacts: { id: string; kind: string; bytes: number; url: string }[];
  inspection: { errors?: string[]; nodes?: { index: number; name: string; skinned: boolean }[]; metrics?: { vertices: number; triangles: number; joints: string[]; animations: string[] } };
  parts: Part[]; body_coverage: string;
  review: { decision?: string; notes?: string; reviewed_at?: string };
};

/** `from` is who refused the request: the character server itself ('studio', its `{error}` or FastAPI's `{detail}`), or
 * the app server or anything else on the way, before the studio saw it ('gateway'). */
export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public from: 'studio' | 'gateway' = 'studio') { super(message); }
}

// A sleeping studio is answered by the app server before or instead of reaching it; a saved request stays pending
// and is replayed under the same key once the studio is up. The app server's other refusals (a spent budget, a paid
// action it does not allow, who may ask) keep their own code: the request never reached the studio, so a first try is
// settled. Its `factory_timeout` is no refusal: the studio took the request and may have started it, so it stays
// pending too.
const transportCodes = new Set(['request_failed', 'connection', 'timeout', 'incomplete_response', 'cancelled', 'studio_waking', 'studio_stopping', 'factory_timeout']);

// A coded server error (including 409 conflicts and 503 configuration errors) means the
// request was not accepted, so its saved identity can be discarded. Connection losses,
// timeouts and uncoded 5xx responses stay pending for an idempotent replay. So does a saved
// request sent again (`replay`) that is refused before the studio sees it (signed out, no longer
// allowed, the budget spent): that says nothing of what its first try started there.
export function isDefinitiveRejection(error: unknown, replay = false): error is ApiError {
  if (!(error instanceof ApiError) || (replay && error.from === 'gateway')) return false;
  if ([400, 401, 403, 404, 409, 422].includes(error.status)) return true;
  return error.status >= 400 && !transportCodes.has(error.code);
}

/** The server refused a change made on a list that has moved on since it was read. */
export const isRevisionConflict = (error: unknown) => error instanceof ApiError && error.code === 'revision_conflict';

export async function request<T>(url: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 15000, signal, ...init } = options;
  const wait = deadline(timeoutMs, signal);
  const sentAt = sessionEpoch();
  try {
  let response: Response;
  try { response = await fetch(url, { ...init, signal: wait.signal }); }
  catch { throw new ApiError('connection', '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', 0); }
  const body = await response.json().catch(() => {
    if (response.ok) throw new ApiError('incomplete_response', '서버 응답을 끝까지 받지 못했습니다. 잠시 후 다시 시도해 주세요.', 0);
    return {};
  });
  // The app server's own refusals ({code, message}): its permission checks, and the studio sleeping (see studioSleep).
  const gateway = !response.ok && typeof body?.code === 'string' && typeof body?.message === 'string' ? body as { code: string; message: string } : null;
  reportStudio(gateway?.code, gateway?.message);
  // The app server refused the session cookie: the session ran out, as anywhere else in the app (the header offers a
  // new sign-in). A 401 the studio itself sends stays this request's own failure.
  if (response.status === 401 && gateway?.code === 'login_required') expireSession(sentAt);
  if (!response.ok) {
    const from = body?.error || body?.detail ? 'studio' : 'gateway';
    // Only when the server sent no message of its own: what happened, in words for whoever is on the screen. FastAPI's
    // `detail` (a framework or configuration message, or field errors) is for the character server's logs, not the
    // screen. A 401 or 403 the studio itself sends refuses the app server's credentials, which signing in again does
    // not mend.
    const fallback = response.status >= 500 || (from === 'studio' && (response.status === 401 || response.status === 403)) ? '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
      : response.status === 401 ? '로그인이 필요합니다. 다시 로그인해 주세요.' : response.status === 404 ? '요청한 자료를 찾을 수 없습니다.' : '요청을 처리하지 못했습니다. 입력을 확인해 주세요.';
    const gatewayCode = gateway && gateway.code !== 'factory_unavailable' ? gateway.code : undefined;
    throw new ApiError(body.error?.code || gatewayCode || 'request_failed', body.error?.message || gateway?.message || fallback, response.status, from);
  }
  return body as T;
  } catch (error) {
    if (wait.timedOut) throw new ApiError('timeout', '서버 응답이 늦어지고 있습니다. 잠시 후 다시 시도해 주세요.', 0);
    if (signal?.aborted) throw new ApiError('cancelled', '조회가 취소되었습니다.', 0);
    throw error;
  } finally {
    wait.clear();
  }
}

export type Pending<T> = { key: string; input: T };

/** A saved request that is not the one being sent. It is neither sent in its place nor dropped: someone resumes it
 * (sends `pending.input` again) or clears it (`settle(pending.key)`) before anything new goes out. */
export class PendingRequestConflict<T = unknown> extends Error {
  constructor(public pending: Pending<T>) { super('응답을 확인하지 못한 다른 요청이 남아 있습니다.'); }
}

/** JSON with object keys in a fixed order, so two inputs compare by what they hold, not how they were built. */
const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const sameInput = (a: unknown, b: unknown) => canonical(a) === canonical(b);

// A request that must not run twice (paid work, a new record) is saved under `storage` with its
// idempotency key before it is sent, so a lost answer replays the same key. A saved value that
// `valid` rejects blocks new requests with `unreadable` until someone looks at it.
export function savedRequest<T>(storage: string, valid: (pending: Pending<T>) => boolean, unreadable: string) {
  const read = (): { pending: Pending<T> | null; error: string } => {
    try {
      const raw = localStorage.getItem(storage);
      if (!raw) return { pending: null, error: '' };
      const pending = JSON.parse(raw) as Pending<T>;
      if (!pending || typeof pending.key !== 'string' || !pending.key || !pending.input || !valid(pending)) throw new Error();
      return { pending, error: '' };
    } catch {
      return { pending: null, error: unreadable };
    }
  };
  // Forgets the saved request only while it is still the one under `key`, even one `valid` would reject.
  const settle = (key: string) => {
    try { if ((JSON.parse(localStorage.getItem(storage) || 'null') as Pending<T> | null)?.key === key) localStorage.removeItem(storage); }
    catch { /* Not JSON, so not the request sent under `key`. */ }
  };
  // Sends `input`: again under the saved key when it is the saved request, else under `key` or a new
  // one. Storage is read as it is sent, so a request saved since the screen last looked (another tab, a
  // lost answer) is never sent in place of `input`: a different saved request refuses with
  // PendingRequestConflict. It is forgotten once the server answers for it (`answered`, any answer by
  // default) or rejects it for good: when it is the saved one sent again, only the studio itself can.
  async function send<R>(input: T, post: (pending: Pending<T>) => Promise<R>,
    options: { key?: string; answered?: (result: R, key: string) => boolean } = {}): Promise<R> {
    const saved = read();
    if (saved.error) throw new Error(saved.error);
    if (saved.pending && !sameInput(saved.pending.input, input)) throw new PendingRequestConflict(saved.pending);
    const pending = saved.pending || { key: options.key || crypto.randomUUID(), input };
    localStorage.setItem(storage, JSON.stringify(pending));
    try {
      const result = await post(pending);
      if (options.answered?.(result, pending.key) ?? true) settle(pending.key);
      return result;
    } catch (error) {
      if (isDefinitiveRejection(error, !!saved.pending)) settle(pending.key);
      throw error;
    }
  }
  return { read, settle, send };
}

const endpoint = (id: string) => `/api/characters/${encodeURIComponent(id)}`;
export const api = {
  list: (signal?: AbortSignal) => request<{ characters: Character[] }>('/api/characters', { signal }),
  create: (name: string, height: number | null) => request<Character>('/api/characters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, height_meters: height }) }),
  upload: (c: Character, file: File, kind: string) => request<Character>(`${endpoint(c.id)}/sources?kind=${kind}`, { method: 'POST', headers: { 'If-Match': c.revision, 'Content-Type': file.type || 'application/octet-stream' }, body: file, timeoutMs: 60000 }),
};
