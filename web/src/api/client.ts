export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal };

/**
 * JSON with the server's session cookie. The server takes writes only as same-origin JSON, so every non-GET request
 * carries a JSON body, `{}` when there is nothing to send.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const write = method !== 'GET' && method !== 'HEAD';
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    ...(write ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body ?? {}) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as { code?: string; message?: string } | null;
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'http_error',
      error?.message ?? `요청이 실패했어요 (${response.status})`,
    );
  }
  return body as T;
}

export const problemText = (problem: unknown) =>
  problem instanceof ApiRequestError ? problem.message : '잠시 후 다시 시도해 주세요';
