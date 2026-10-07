/**
 * Which preview cards may hold a live 3D viewer. Every viewer holds a renderer and a GPU device of its own, and a browser
 * keeps only about 16 WebGL contexts (fewer on phones), so all cards together hold at most `MAX_LIVE`; a card without one
 * shows a still picture instead (see AssetModelPreview).
 *
 * A card claims a viewer while it wants to show its model. Pinned claims (a detail view) are never taken back. On screen
 * beats off screen; among cards on screen the one pointed at or focused most recently wins, so a card handed back takes
 * the viewer of the card used longest ago, and cards that merely scroll in wait for a free one. Off screen a card keeps
 * its viewer for `HIDDEN_MS`, and only the `KEEP_HIDDEN` most recently hidden do, so scrolling back does not load the
 * model again.
 */
export const MAX_LIVE = 8, KEEP_HIDDEN = 3, HIDDEN_MS = 60_000;

export type ViewerClaim = {
  /** The card is on screen or not. */
  show(visible: boolean): void;
  /** The card was pointed at or focused: it is the most recently used, and takes a viewer from a less recent card. */
  touch(): void;
  /** The card no longer wants a viewer (closed, switched to its image, or gone). */
  release(): void;
};
type Entry = {
  pinned: boolean; visible: boolean; touched: number; hiddenAt: number; live: boolean;
  grant(): void; revoke(): void; timer?: ReturnType<typeof setTimeout>;
};

const entries = new Set<Entry>();
let clock = 0;

const rank = (entry: Entry) => (entry.pinned ? 2 : 0) + (entry.visible ? 1 : 0);
/** Positive when `a` has the better right to a viewer than `b`. */
const compare = (a: Entry, b: Entry) => rank(a) - rank(b) || a.touched - b.touched;

function revoke(entry: Entry) {
  if (!entry.live) return;
  entry.live = false; clearTimeout(entry.timer); entry.timer = undefined;
  entry.revoke();
}
function grant(entry: Entry) {
  entry.live = true;
  entry.grant();
}

function settle() {
  const all = [...entries];
  // Hidden viewers beyond those that may stay go first, longest hidden first.
  const hidden = all.filter(entry => entry.live && !entry.visible && !entry.pinned).sort((a, b) => a.hiddenAt - b.hiddenAt);
  hidden.slice(0, Math.max(0, hidden.length - KEEP_HIDDEN)).forEach(revoke);
  // Over budget (fewer slots than before), the least entitled give theirs up.
  const holding = () => all.filter(entry => entry.live);
  for (const entry of holding().filter(item => !item.pinned).sort(compare)) {
    if (holding().length <= MAX_LIVE) break;
    revoke(entry);
  }
  // Waiting cards on screen, most entitled first (claim order breaks ties), take free viewers, then those of cards less
  // entitled than they are. A pinned claim always gets one, from the least entitled card when there is one.
  const waiting = all.filter(entry => !entry.live && (entry.visible || entry.pinned)).sort((a, b) => compare(b, a));
  for (const want of waiting) {
    const live = holding();
    if (live.length >= MAX_LIVE) {
      const victim = live.filter(entry => !entry.pinned).sort(compare)[0];
      if (victim && (want.pinned || compare(want, victim) > 0)) revoke(victim);
      else if (!want.pinned) continue;
    }
    grant(want);
  }
}

/**
 * Claims a viewer for a card. `grant` says it may build one now; `revoke` says to let it go (taking a still picture
 * first if it can). Neither is called after `release`.
 */
export function claimViewer({ pinned, visible, grant: onGrant, revoke: onRevoke }: {
  pinned: boolean; visible: boolean; grant(): void; revoke(): void;
}): ViewerClaim {
  const entry: Entry = { pinned, visible, touched: 0, hiddenAt: visible ? 0 : ++clock, live: false, grant: onGrant, revoke: onRevoke };
  entries.add(entry);
  settle();
  return {
    show(next) {
      if (!entries.has(entry) || entry.visible === next) return;
      entry.visible = next; clearTimeout(entry.timer); entry.timer = undefined;
      if (!next) {
        entry.hiddenAt = ++clock;
        if (entry.live && !entry.pinned) entry.timer = setTimeout(() => { revoke(entry); settle(); }, HIDDEN_MS);
      }
      settle();
    },
    touch() {
      if (!entries.has(entry)) return;
      entry.touched = ++clock;
      settle();
    },
    release() {
      if (!entries.delete(entry)) return;
      clearTimeout(entry.timer);
      entry.live = false;
      settle();
    },
  };
}

/** For tests: how many claims hold a viewer now. */
export const liveViewers = () => [...entries].filter(entry => entry.live).length;
