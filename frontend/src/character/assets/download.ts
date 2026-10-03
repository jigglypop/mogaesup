/** How long a model request waits for the server to answer, and then for each next piece of the file. */
export const ANSWER_TIMEOUT_MS = 20_000;
export const STALL_TIMEOUT_MS = 20_000;

const timeout = () => new DOMException('The download stopped arriving in time', 'TimeoutError');
const aborted = () => new DOMException('The download was cancelled', 'AbortError');

/**
 * A file's bytes. The clock covers waiting, never size: the answer's headers must arrive within `answerMs`, and after
 * that the body only has to keep arriving, each piece within `stallMs` of the last, so a 256 MB model on a slow line
 * takes as long as it takes. Fails as `fetch` does: a TimeoutError when either wait runs out, an AbortError once
 * `signal` aborts, and `refused` as the message when the server answers but not with the file.
 */
export async function downloadBytes(url: string, { signal, refused, answerMs = ANSWER_TIMEOUT_MS, stallMs = STALL_TIMEOUT_MS }: {
  signal?: AbortSignal; refused: string; answerMs?: number; stallMs?: number;
}): Promise<ArrayBuffer> {
  if (signal?.aborted) throw aborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => controller.abort(timeout()), ms); };
  const cancel = () => controller.abort(aborted());
  signal?.addEventListener('abort', cancel, { once: true });
  // Settles only by failing, the moment either clock runs out or the caller cancels, whatever the request is doing.
  const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
  stopped.catch(() => undefined);
  // Whatever the browser threw on the way, the reason the screen gets is the clock's or the caller's.
  const failure = (error: unknown) => controller.signal.aborted ? controller.signal.reason : error;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    wait(answerMs);
    let response: Response;
    try { response = await Promise.race([fetch(url, { signal: controller.signal }), stopped]); }
    catch (error) { throw failure(error); }
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error(refused); }
    if (!response.body) {
      wait(stallMs);
      try { return await Promise.race([response.arrayBuffer(), stopped]); }
      catch (error) { throw failure(error); }
    }
    reader = response.body.getReader();
    const pieces: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      wait(stallMs);
      let piece: ReadableStreamReadResult<Uint8Array>;
      try { piece = await Promise.race([reader.read(), stopped]); }
      catch (error) { throw failure(error); }
      if (piece.done) break;
      pieces.push(piece.value); length += piece.value.byteLength;
    }
    reader = undefined;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
    return bytes.buffer;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    // A download given up part way stops here rather than finishing in the background.
    if (reader) void reader.cancel().catch(() => undefined);
  }
}
