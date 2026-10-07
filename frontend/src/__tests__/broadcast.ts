/**
 * A BroadcastChannel for tests: a message reaches every other open channel of the same name at once, as another tab's
 * would (never the one that sent it). Node's own channel reaches across test files and outlives a test.
 */
export class FakeChannel {
  static open = new Set<FakeChannel>();
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly name: string) {
    FakeChannel.open.add(this);
  }

  postMessage(data: unknown) {
    if (!FakeChannel.open.has(this)) throw new DOMException('closed', 'InvalidStateError');
    for (const other of [...FakeChannel.open]) {
      if (other !== this && other.name === this.name) other.onmessage?.(new MessageEvent('message', { data }));
    }
  }

  close() {
    FakeChannel.open.delete(this);
  }
}
