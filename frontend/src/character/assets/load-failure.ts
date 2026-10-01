/**
 * A model or image request that ran out of time or was cancelled, in words for the screen: the browser's own texts for
 * either ("The operation was aborted due to timeout") are English. Any other failure passes through as it is.
 */
export function loadFailure(error: unknown, what: string): Error {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError') return new Error(`${what} 불러오기 시간이 초과되었습니다.`);
  if (name === 'AbortError') return new Error(`${what} 불러오기가 취소되었습니다.`);
  return error instanceof Error ? error : new Error(String(error));
}
