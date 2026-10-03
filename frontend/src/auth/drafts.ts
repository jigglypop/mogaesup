/** Unsent text a member typed, kept in this browser under their account's id until it is saved. */
const PREFIX = 'mogaesup:draft:';

/** The storage key of one draft of the member `ownerId`. */
export const draftKey = (ownerId: string, name: string) => `${PREFIX}${ownerId}:${name}`;

/** Drops every kept draft; signing out (or someone else signing in) leaves none behind in this browser. */
export function clearDrafts(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable; then nothing was kept either.
  }
}
