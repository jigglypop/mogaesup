/**
 * One loaded resource per wanted key. A key is loaded once however often it is asked for while it loads; a resource is
 * released when its key is no longer wanted, and straight away if it arrives after that. A load that fails is dropped,
 * so the next `want` of that key tries again.
 */
export function createHeldLoads<Input, Value>(options: {
  load: (input: Input, signal: AbortSignal) => Promise<Value>;
  release: (value: Value) => void;
  /** The wanted key's resource arrived. */
  ready: (key: string, value: Value) => void;
  /** The key's resource was let go. */
  dropped?: (key: string) => void;
}) {
  const held = new Map<string, Value>();
  const loading = new Map<string, AbortController>();
  let disposed = false;

  return {
    /** Starts what is wanted and neither held nor loading, and lets go of everything else. */
    want(wanted: ReadonlyMap<string, Input>) {
      if (disposed) return;
      for (const [key, controller] of loading) {
        if (wanted.has(key)) continue;
        controller.abort();
        loading.delete(key);
      }
      for (const [key, value] of held) {
        if (wanted.has(key)) continue;
        held.delete(key);
        options.release(value);
        options.dropped?.(key);
      }
      for (const [key, input] of wanted) {
        if (held.has(key) || loading.has(key)) continue;
        const controller = new AbortController();
        loading.set(key, controller);
        new Promise<Value>((resolve) => resolve(options.load(input, controller.signal))).then(
          (value) => {
            if (controller.signal.aborted) {
              options.release(value);
              return;
            }
            loading.delete(key);
            held.set(key, value);
            options.ready(key, value);
          },
          () => {
            if (loading.get(key) === controller) loading.delete(key);
          },
        );
      }
    },
    /** Lets go of everything, for good. */
    dispose() {
      disposed = true;
      loading.forEach((controller) => controller.abort());
      loading.clear();
      held.forEach((value) => options.release(value));
      held.clear();
    },
  };
}
