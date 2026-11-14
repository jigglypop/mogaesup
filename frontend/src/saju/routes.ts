import { MY_HOME, sampleOf } from './residents';

/** Where the village's pages live. */
export const SAJU = '/saju';
export const VILLAGE = `${SAJU}/village`;
export const EDIT = `${SAJU}/edit`;
/** A resident's 미니홈피: the viewer's own at the root, a neighbour's under `home/`. */
export const homePath = (id: string) => (id === MY_HOME ? SAJU : `${SAJU}/home/${encodeURIComponent(id)}`);
/** The same home's 사주보기. */
export const chartPath = (id: string) => `${homePath(id)}?view=chart`;

export type SajuRoute =
  /** The viewer's own home; the way to build one while they have none. */
  | { kind: 'mine'; chart: boolean }
  /** Their name and birth, to correct. */
  | { kind: 'edit' }
  | { kind: 'village' }
  | { kind: 'home'; id: string; chart: boolean }
  /** An address that is not a page here, and where to go instead. */
  | { kind: 'redirect'; to: string };

/**
 * The page an address under `/saju` shows: `rest` is the path after it (as the router's `*` gives it) and `search` its
 * query. Without a home of their own (`hasHome` false) the viewer has nothing to edit.
 */
export function routeOf(rest: string, search: string, hasHome: boolean): SajuRoute {
  const parts = rest.split('/').filter(Boolean);
  const chart = new URLSearchParams(search).get('view') === 'chart';
  if (parts.length === 0) return { kind: 'mine', chart: chart && hasHome };
  if (parts.length === 1 && parts[0] === 'village') return { kind: 'village' };
  if (parts.length === 1 && parts[0] === 'edit') return hasHome ? { kind: 'edit' } : { kind: 'redirect', to: SAJU };
  if (parts.length === 2 && parts[0] === 'home') {
    const id = decodeURIComponent(parts[1]!);
    if (id === MY_HOME) return { kind: 'redirect', to: SAJU };
    return sampleOf(id) ? { kind: 'home', id, chart } : { kind: 'redirect', to: VILLAGE };
  }
  return { kind: 'redirect', to: SAJU };
}

/** 파도타기: the neighbour after `current` among `ids` (the first for someone standing outside them), round and round. */
export function nextWave(ids: readonly string[], current: string | null): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  const next = ids[(at + 1) % ids.length]!;
  return next === current ? null : next;
}
