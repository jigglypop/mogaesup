export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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
  /** How long the whole exchange may take before it is given up as unanswered; 30 seconds by default. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

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
 * `ApiTimeoutError` rather than holding whoever waits on it for good.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const write = method !== 'GET' && method !== 'HEAD';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wait = deadline(timeoutMs, options.signal);
  try {
    const response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      ...(write ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body ?? {}) } : {}),
      signal: wait.signal,
    });
    if (response.status === 204) return undefined as T;
    // Not JSON (a proxy's error page) reads as no body, but a read the clock cut short is a failure of its own.
    const body: unknown = await response.json().catch((error: unknown) => (wait.signal.aborted ? Promise.reject(error) : null));
    if (!response.ok) {
      const error = body as { code?: string; message?: string } | null;
      throw new ApiRequestError(
        response.status,
        error?.code ?? 'http_error',
        error?.message ?? `요청이 실패했어요 (${response.status})`,
      );
    }
    return body as T;
  } catch (error) {
    if (wait.timedOut && (error as { name?: unknown } | null)?.name === 'AbortError') throw new ApiTimeoutError(timeoutMs);
    throw error;
  } finally {
    wait.clear();
  }
}

export const problemText = (problem: unknown) =>
  problem instanceof ApiRequestError ? problem.message : '잠시 후 다시 시도해 주세요';
