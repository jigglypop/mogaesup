import { cookieReplaced, expireSession, sessionEpoch, startOver } from '../auth/sessionWork';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * The server refused a session cookie this page has replaced since, or was replacing (`startOver`): the session goes
     * on, and the same request may go again.
     */
    readonly staleCookie = false,
  ) {
    super(message);
  }
}

/** No answer came in time. What the server did with the request is unknown, so callers treat it like a lost connection. */
export class ApiTimeoutError extends Error {
  constructor(readonly ms: number) {
    super('서버가 대답하지 않아요');
    this.name = 'ApiTimeoutError';
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  keepalive?: boolean;
  headers?: Record<string, string>;
  /** How long the whole exchange may take before it is given up as unanswered; `DEFAULT_TIMEOUT_MS` by default. */
  timeoutMs?: number;
  /** The request starts the session over (a new cookie comes with its answer; see `startOver`). */
  startsOver?: boolean;
};

/**
 * How long a request may go unanswered by default: longer than the server's own waits on an API route (they end within
 * 25 seconds), so that whatever it answers (`wardrobe_busy`, `timeout`) arrives before the request is given up. A
 * request that waits on the character server (the server answers `factory_timeout` at 57 s, and the CDN waits 60 s for
 * it, see infra/aws-static.yaml) sets a `timeoutMs` of its own.
 */
export const DEFAULT_TIMEOUT_MS = 35_000;
/** The code the server answers a request with when it no longer takes the session cookie (server/src/error.rs). */
export const SESSION_REFUSED = 'login_required';

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/**
 * What an error answer says: the app server's own `{code, message}` (`own`, the only kind that speaks for the session
 * cookie), or the character server's `{error: {code, message}}`, which the studio's routes pass on as it is.
 */
function refusalOf(body: unknown): { own?: string; code?: string; message?: string } {
  if (typeof body !== 'object' || body === null) return {};
  const outer = body as { code?: unknown; message?: unknown; error?: unknown };
  const own = text(outer.code);
  if (own) return { own, code: own, message: text(outer.message) };
  const inner = typeof outer.error === 'object' && outer.error !== null ? (outer.error as { code?: unknown; message?: unknown }) : {};
  return { code: text(inner.code), message: text(inner.message) ?? text(outer.message) };
}

/**
 * A signal that aborts when `outer` does or after `timeoutMs`; `timedOut` tells the clock from the caller.
 * Call `clear` once the exchange is over.
 */
export function deadline(timeoutMs: number, outer?: AbortSignal | null) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (outer?.aborted) cancel();
  outer?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    clear() {
      clearTimeout(timer);
      outer?.removeEventListener('abort', cancel);
    },
  };
}

/**
 * JSON with the server's session cookie. The server takes writes only as same-origin JSON, so every non-GET request
 * carries a JSON body, `{}` when there is nothing to send. A request that gets no answer in time fails with
 * `ApiTimeoutError` rather than holding whoever waits on it for good. The server's own refusal of the session cookie
 * (`login_required`) means the session ran out, and signs the member out (`expireSession`), but not while a request
 * that starts the session over is on its way (`startsOver`), nor for a cookie replaced since the request went out
 * (`staleCookie`); any other 401 (a wrong password, a refused realtime ticket) is that request's failure alone.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const write = method !== 'GET' && method !== 'HEAD';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wait = deadline(timeoutMs, options.signal);
  const sentAt = sessionEpoch();
  const over = options.startsOver ? startOver() : null;
  try {
    const response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...options.headers, ...(write ? { 'content-type': 'application/json' } : {}) },
      ...(write ? { body: JSON.stringify(options.body ?? {}) } : {}),
      signal: wait.signal,
      ...(options.keepalive ? { keepalive: true } : {}),
    });
    // The new cookie comes with the answer's headers, whatever becomes of its body.
    if (response.ok) over?.('renewed');
    if (response.status === 204) return undefined as T;
    // Not JSON (a proxy's error page) reads as no body, but a read the clock cut short is a failure of its own.
    const body: unknown = await response.json().catch((error: unknown) => (wait.signal.aborted ? Promise.reject(error) : null));
    if (!response.ok) {
      const said = refusalOf(body);
      let stale = false;
      if (response.status === 401 && said.own === SESSION_REFUSED) {
        if (over) over('refused');
        else {
          stale = cookieReplaced(sentAt);
          expireSession(sentAt);
        }
      }
      throw new ApiRequestError(response.status, said.code ?? 'http_error', said.message ?? `요청이 실패했어요 (${response.status})`, stale);
    }
    return body as T;
  } catch (error) {
    if (wait.timedOut && (error as { name?: unknown } | null)?.name === 'AbortError') throw new ApiTimeoutError(timeoutMs);
    throw error;
  } finally {
    over?.();
    wait.clear();
  }
}

/** What went wrong, for the screen: the server's own words, but for a refusal that was not the request's (a stale cookie). */
export const problemText = (problem: unknown) =>
  problem instanceof ApiRequestError && !problem.staleCookie ? problem.message : '잠시 후 다시 시도해 주세요';
