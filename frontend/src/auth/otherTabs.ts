/** The channel (and, without BroadcastChannel, the storage key) tabs of this site tell each other sign-ins on. */
export const SESSION_CHANNEL = 'mogaesup:session';

/** What a tab tells the others: who it signed in as (null: it signed out), and whether it started the session over. */
export type SessionNews = { userId: string | null; renewed?: true };

export type SessionChannel = {
  /**
   * Tells the other tabs this one signed in as `userId`, or out (null); `renewed`: the same member's session went on
   * under a new cookie (a password change, signing out the other devices).
   */
  announce: (userId: string | null, renewed?: boolean) => void;
  close: () => void;
};

/** The news in a message, read as leniently as it was written; anything else still says that something changed. */
function newsOf(data: unknown): SessionNews {
  const said = typeof data === 'object' && data !== null ? (data as { userId?: unknown; renewed?: unknown }) : {};
  return { userId: typeof said.userId === 'string' ? said.userId : null, ...(said.renewed === true ? { renewed: true } : {}) };
}

const messageOf = (userId: string | null, renewed: boolean) => (renewed ? { userId, renewed: true } : { userId });

/**
 * The session cookie is shared by every tab of the site, so a sign-in or sign-out in one changes who the others act as,
 * and a session started over in one sends the others a new cookie too. Each tab says so, and `changed` runs in the
 * others (never in the tab that said it). A BroadcastChannel carries it; where there is none, a write to localStorage
 * does (its `storage` event reaches only the other tabs).
 */
export function openSessionChannel(changed: (news: SessionNews) => void): SessionChannel {
  if (typeof BroadcastChannel === 'function') {
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.onmessage = (event: MessageEvent) => changed(newsOf(event.data));
    return {
      announce: (userId, renewed = false) => {
        try {
          channel.postMessage(messageOf(userId, renewed));
        } catch {
          // A closed channel tells nobody; the other tabs still ask when they are shown.
        }
      },
      close: () => channel.close(),
    };
  }
  const heard = (event: StorageEvent) => {
    if (event.key !== SESSION_CHANNEL || event.newValue === null) return;
    let data: unknown = null;
    try {
      data = JSON.parse(event.newValue);
    } catch {
      // Unreadable, but still a change.
    }
    changed(newsOf(data));
  };
  window.addEventListener('storage', heard);
  return {
    announce: (userId, renewed = false) => {
      try {
        // The time makes each write a change, so the same member signing in twice is heard twice.
        localStorage.setItem(SESSION_CHANNEL, JSON.stringify({ ...messageOf(userId, renewed), at: Date.now(), nonce: Math.random() }));
      } catch {
        // Storage may be unavailable; the other tabs still ask when they are shown.
      }
    },
    close: () => window.removeEventListener('storage', heard),
  };
}
