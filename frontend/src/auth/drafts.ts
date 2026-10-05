/** Unsent text and other unfinished work a member left in this browser, kept under their account's id. */
const PREFIX = 'mogaesup:draft:';
/** Where the layout composer kept its paid-request record before it moved under `PREFIX`. */
const LEGACY_PREFIXES = ['mogaesup:layout-interpretations:'];

/** The storage key of one draft of the member `ownerId`. */
export const draftKey = (ownerId: string, name: string) => `${PREFIX}${ownerId}:${name}`;

/** Whose a stored key is: the member id of a draft (or of an old record), undefined for keys that are not drafts. */
function ownerOf(key: string): string | undefined {
  if (key.startsWith(PREFIX)) return key.slice(PREFIX.length).split(':')[0];
  const legacy = LEGACY_PREFIXES.find((prefix) => key.startsWith(prefix));
  return legacy === undefined ? undefined : key.slice(legacy.length);
}

/**
 * Drops every kept draft but those of `keep`: signing out leaves none behind in this browser, and signing in leaves
 * only the member's own (a session that lapsed, then a reload and someone else signing in, leaves nobody else's).
 */
export function clearDrafts(keep: string | null = null): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      const owner = key === null ? undefined : ownerOf(key);
      if (key !== null && owner !== undefined && owner !== keep) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable; then nothing was kept either.
  }
}
