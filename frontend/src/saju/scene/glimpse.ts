// The last picture of a 섬 this browser drew, kept to show at once the next time the page opens on it, while the
// canvas makes the village ready again; the canvas comes up over it when it shows. Kept in the browser's Cache Storage
// under names of its own (never fetched from anywhere), the latest few: one for each view of each 섬, at each size of
// the window and each hour of the day, since a picture only lines up with the canvas as it was taken. A new version of
// the 섬's code (__SAJU_SCENE__, see shelf) draws the islands anew, so what an older one drew is let go.

declare const __SAJU_SCENE__: string;

const STORES = 'mg-saju-glimpses-';
const STORE = `${STORES}${__SAJU_SCENE__}`;
/** How many pictures are kept, the ones taken longest ago let go first. */
const KEEP = 24;
/** How the pictures are kept: small, and soft enough for the moment they are seen. */
const KIND = 'image/webp';
const QUALITY = 0.8;

const requestOf = (key: string) => new Request(new URL(`/__saju/glimpse/${encodeURIComponent(key)}`, location.origin));

let pruned = false;

async function store(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    if (!pruned) {
      pruned = true;
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(STORES) && name !== STORE).map((name) => caches.delete(name)));
    }
    return await caches.open(STORE);
  } catch {
    // Storage this page may not use (a private window that refuses it, say): there is just no picture.
    return null;
  }
}

/** The picture kept under `key`, if there is one. */
export async function readGlimpse(key: string): Promise<Blob | null> {
  try {
    const hit = await (await store())?.match(requestOf(key));
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}

/** Keeps `picture` under `key`, in place of what was kept there; the oldest go past {@link KEEP}. */
export async function keepGlimpse(key: string, picture: Blob): Promise<void> {
  const cache = await store();
  if (!cache) return;
  try {
    await cache.put(requestOf(key), new Response(picture, { headers: { 'content-type': picture.type } }));
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - KEEP)).map((old) => cache.delete(old)));
  } catch {
    // Out of room, or storage gone: the next visit opens without a picture, as the first did.
  }
}

/**
 * What `canvas` shows, at `width` by `height` (its size on the page), as a picture to keep. It is taken as the call is
 * made: right after the canvas has drawn a frame, in the same task, before the browser shows the frame and lets it go.
 */
export function takeGlimpse(canvas: HTMLCanvasElement, width: number, height: number): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return Promise.resolve(null);
  const across = Math.max(1, Math.round(width));
  const down = Math.max(1, Math.round(height));
  return createImageBitmap(canvas, { resizeWidth: across, resizeHeight: down, resizeQuality: 'medium' })
    .then((bitmap) => {
      const board = new OffscreenCanvas(across, down);
      const context = board.getContext('2d');
      if (!context) {
        bitmap.close();
        return null;
      }
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return board.convertToBlob({ type: KIND, quality: QUALITY });
    })
    .catch(() => null);
}
