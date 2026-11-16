// The tiles a village is painted with (what its surfaces are made of, the lake's foam and ripples) are painted from
// noise, a few tens of milliseconds each and some fifteen of them: on the main thread they held up the island being
// built and its shaders being made. They are painted here by workers instead, side by side, from the moment the 섬's
// code arrives (while the page still reads the 섬 and builds it): every tile a village wears, most worn first. A texture
// is handed out at once and filled when its tile comes; the canvas does not show until every texture handed out is
// filled (Stage's Ready). Without workers (an old browser, the tests) a tile is painted on the spot, as before.

import { SURFACES, type Surface } from './surfaceRecipes';

/** What a worker is asked to paint. */
export type PaintRequest = { kind: 'surface'; surface: Exclude<Surface, 'plain'> } | { kind: 'foam' } | { kind: 'detail'; windAngle: number };
/** A worker's job: the tile, and the key its arrays are sent back under. */
export type PaintJob = { key: string; request: PaintRequest };
/** What a worker sends back: the tile's arrays, or why it could not paint them. */
export type PaintReply = { key: string; data?: Uint8Array[]; failed?: string };

const keyOf = (request: PaintRequest): string =>
  request.kind === 'surface' ? `surface:${request.surface}` : request.kind === 'detail' ? `detail:${request.windAngle}` : request.kind;

/** Tiles painted that nobody has asked for yet. */
const painted = new Map<string, Uint8Array[]>();
/** Who waits for a tile, and how to paint it here should its worker fail. */
const waiting = new Map<string, { fill: (data: Uint8Array[]) => void; now: () => Uint8Array[] }>();
/** Which worker paints which tile. */
const painting = new Map<string, Worker>();
const workers: Worker[] = [];
let turn = 0;

/** Gives the tile under `key` to whoever waits for it, painting it here if `data` did not come. */
function deliver(key: string, data: Uint8Array[] | null): void {
  const waiter = waiting.get(key);
  if (!waiter) {
    if (data) painted.set(key, data);
    return;
  }
  waiting.delete(key);
  waiter.fill(data ?? waiter.now());
}

/** A worker that stopped (it could not load, or broke): what it was painting is painted here, and nothing more is sent it. */
function lose(worker: Worker): void {
  const at = workers.indexOf(worker);
  if (at >= 0) workers.splice(at, 1);
  worker.terminate();
  for (const [key, by] of [...painting]) {
    if (by !== worker) continue;
    painting.delete(key);
    deliver(key, null);
  }
}

function send(request: PaintRequest): boolean {
  if (workers.length === 0) return false;
  const worker = workers[turn++ % workers.length]!;
  const key = keyOf(request);
  painting.set(key, worker);
  worker.postMessage({ key, request } satisfies PaintJob);
  return true;
}

function start(): void {
  if (typeof Worker !== 'function') return;
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  const count = cores >= 6 ? 3 : cores >= 4 ? 2 : 1;
  try {
    for (let index = 0; index < count; index++) {
      const worker = new Worker(new URL('./paint.worker.ts', import.meta.url), { type: 'module', name: 'saju-painter' });
      worker.onmessage = ({ data: { key, data } }: MessageEvent<PaintReply>) => {
        painting.delete(key);
        deliver(key, data ?? null);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        lose(worker);
      };
      workers.push(worker);
    }
  } catch {
    for (const worker of workers.splice(0)) worker.terminate();
    return;
  }
  for (const surface of SURFACES) send({ kind: 'surface', surface });
  send({ kind: 'foam' });
}

start();

/**
 * Has `fill` given the tile `request` asks for: at once if it is painted already, else when its worker sends it. Where
 * there is no worker, `now` paints it on the spot.
 */
export function paint(request: PaintRequest, now: () => Uint8Array[], fill: (data: Uint8Array[]) => void): void {
  const key = keyOf(request);
  const done = painted.get(key);
  if (done) {
    painted.delete(key);
    fill(done);
    return;
  }
  if (!painting.has(key) && !send(request)) {
    fill(now());
    return;
  }
  waiting.set(key, { fill, now });
}

/** How many textures handed out still wait for their tiles: the canvas shows once none do. */
export const paintsPending = (): number => waiting.size;
