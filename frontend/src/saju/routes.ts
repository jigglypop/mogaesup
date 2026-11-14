/** A member's 미니홈피 and its pages. */
export const homePath = (username: string) => `/@${username}`;
/** The same home's 사주보기. */
export const chartPath = (username: string) => `${homePath(username)}?view=chart`;
/** The member's village: their home among their 이웃'. */
export const villagePath = (username: string) => `${homePath(username)}/village`;
/** Where its owner corrects the name and birth a home is built from. */
export const editPath = (username: string) => `${homePath(username)}/edit`;

export type MinihomeRoute =
  /** The home; the way to build it for an owner who has none. */
  | { kind: 'home'; chart: boolean }
  /** The owner's name and birth, to correct. */
  | { kind: 'edit' }
  | { kind: 'village' }
  /** An address that is not a page here, and where to go instead. */
  | { kind: 'redirect'; to: string };

/**
 * The page an address under `/@username` shows: `rest` is the path after it (as the router's `*` gives it) and `search`
 * its query. Only the owner corrects a home, and only a built one has a chart to read.
 */
export function routeOf(username: string, rest: string, search: string, home: { owner: boolean; built: boolean }): MinihomeRoute {
  const parts = rest.split('/').filter(Boolean);
  const chart = new URLSearchParams(search).get('view') === 'chart';
  if (parts.length === 0) return { kind: 'home', chart: chart && home.built };
  if (parts.length === 1 && parts[0] === 'village') return { kind: 'village' };
  if (parts.length === 1 && parts[0] === 'edit' && home.owner && home.built) return { kind: 'edit' };
  return { kind: 'redirect', to: homePath(username) };
}

/** The pages `/@username` has besides the home itself. */
export const isMinihomePage = (rest: string) => rest === '' || rest === 'village' || rest === 'edit';

/**
 * Where an address of the 사주 village's first days (`/saju`, `/saju/village`, `/saju/edit`, `/saju/home/…`) leads
 * now that every member's home is their 미니홈피: the same page of the viewer's own.
 */
export function movedPath(username: string, rest: string, search: string): string {
  const page = rest.split('/').filter(Boolean)[0];
  if (page === 'village') return villagePath(username);
  if (page === 'edit') return editPath(username);
  return `${homePath(username)}${page === undefined ? search : ''}`;
}

/** 파도타기: on to one of the homes around this one, any but the viewer's own; null when there is no other. */
export function waveOf(ids: readonly string[], viewer: string | null, random: () => number = Math.random): string | null {
  const others = ids.filter((id) => id !== viewer);
  return others[Math.floor(random() * others.length)] ?? null;
}
