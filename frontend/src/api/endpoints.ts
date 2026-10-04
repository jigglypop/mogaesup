import { sessionEpoch } from '../auth/sessionWork';
import { api } from './client';
import type {
  AdminCatalogItem,
  CatalogChanges,
  CatalogImport,
  CatalogItem,
  CatalogKind,
  CatalogStatus,
  CatalogVersion,
  Credentials,
  FactoryCharacter,
  FactoryImport,
  FactoryUsage,
  GuestbookPage,
  HomeListQuery,
  HomeSummary,
  HomeView,
  HomeWorld,
  Ilchon,
  IlchonAsk,
  IlchonRequest,
  IlchonStatus,
  Look,
  LookRequest,
  LayoutInterpretInput,
  LayoutInterpretation,
  LayoutCapabilities,
  ProfileChanges,
  RealtimeTicket,
  Registration,
  SavedHomeWorld,
  SaveHomeWorld,
  StudioPower,
  User,
  VisitCounter,
} from './types';

const segment = encodeURIComponent;

/** `/homes` with only the paging and search that are set. */
export function homesPath({ limit, before, q }: HomeListQuery = {}): string {
  const query = new URLSearchParams();
  if (limit) query.set('limit', String(limit));
  if (before) query.set('before', before);
  if (q) query.set('q', q);
  const text = query.toString();
  return text ? `/homes?${text}` : '/homes';
}

export const authApi = {
  me: () => api<{ user: User | null }>('/auth/me'),
  register: (body: Registration) => api<{ user: User }>('/auth/register', { method: 'POST', body }),
  login: (body: Credentials) => api<{ user: User }>('/auth/login', { method: 'POST', body }),
  logout: () => api<void>('/auth/logout', { method: 'POST' }),
  realtimeTicket: () => api<RealtimeTicket>('/auth/realtime-ticket', { method: 'POST' }),
};

export const homeApi = {
  list: (query?: HomeListQuery, signal?: AbortSignal) => api<{ homes: HomeSummary[] }>(homesPath(query), { signal }),
  get: (username: string) => api<HomeView>(`/homes/${segment(username)}`),
  /** The caller's own home, created on the spot if it is missing. */
  mine: () => api<HomeView>('/homes/me'),
  update: (body: ProfileChanges & { expectedOwnerId: string }) => api<HomeView>('/homes/me', { method: 'PATCH', body, keepalive: true }),
  visit: (username: string, visitorId: string) =>
    api<VisitCounter>(`/homes/${segment(username)}/visits`, { method: 'POST', body: { visitorId } }),
  /** Undefined until the owner first saves. */
  world: (username: string, worldId: string, signal?: AbortSignal) =>
    api<HomeWorld | undefined>(`/homes/${segment(username)}/world?worldId=${segment(worldId)}`, { signal }),
  /** An island is up to 2MB, so a save may take longer than other requests before it counts as unanswered. */
  saveWorld: (body: SaveHomeWorld, signal?: AbortSignal) => api<SavedHomeWorld>('/homes/me/world', { method: 'PUT', body, signal, timeoutMs: 60_000 }),
  /** The link preview's picture: a 1200×630 JPEG as a data URL, which the server checks and encodes again. */
  setThumbnail: (body: { expectedOwnerId: string; image: string }) =>
    api<HomeView>('/homes/me/thumbnail', { method: 'PUT', body, timeoutMs: 60_000 }),
  /** The link preview shows the site's own picture again. */
  removeThumbnail: (body: { expectedOwnerId: string }) => api<HomeView>('/homes/me/thumbnail', { method: 'DELETE', body }),
};

/** The island's link to send: the server's share page, which link previews read and which takes people on to the island. */
export const shareUrl = (username: string, origin: string = window.location.origin) =>
  `${origin}/api/share/@${segment(username)}`;

type IlchonRequests = { received: IlchonRequest[]; sent: IlchonRequest[] };
/**
 * The read of the viewer's 이웃 requests on its way, with the session it was sent in. The bell and the island's 이웃 tab
 * ask at the same moments (opening the island, a change made in either), so they share it; never across a sign-in.
 */
let requestsRead: { epoch: number; read: Promise<IlchonRequests> } | null = null;
/** A change to the requests: a read already on its way may predate it, so the next one goes to the server. */
const changesRequests = <T>(call: Promise<T>) => call.finally(() => { requestsRead = null; });

export const socialApi = {
  guestbook: (username: string, before?: string, signal?: AbortSignal) =>
    api<GuestbookPage>(`/homes/${segment(username)}/guestbook${before ? `?before=${segment(before)}` : ''}`, { signal }),
  write: (username: string, body: { body: string; secret: boolean }) =>
    api<{ id: string }>(`/homes/${segment(username)}/guestbook`, { method: 'POST', body }),
  remove: (id: string) => api<void>(`/guestbook/${segment(id)}`, { method: 'DELETE' }),
  ilchons: (username: string) => api<{ ilchons: Ilchon[] }>(`/homes/${segment(username)}/ilchons`),
  status: (username: string) => api<IlchonStatus>(`/ilchon/${segment(username)}`),
  request: (username: string, body: IlchonAsk) =>
    changesRequests(api<{ relation: 'requested' }>(`/ilchon/${segment(username)}/request`, { method: 'POST', body })),
  unlink: (username: string) => api<void>(`/ilchon/${segment(username)}`, { method: 'DELETE' }),
  /** Joins a read of this session still on its way rather than sending another. */
  requests: () => {
    const epoch = sessionEpoch();
    if (requestsRead?.epoch === epoch) return requestsRead.read;
    const read = api<IlchonRequests>('/ilchon-requests'), entry = { epoch, read };
    requestsRead = entry;
    const done = () => { if (requestsRead === entry) requestsRead = null; };
    read.then(done, done);
    return read;
  },
  accept: (id: string, body: { name?: string }) =>
    changesRequests(api<IlchonStatus>(`/ilchon-requests/${segment(id)}/accept`, { method: 'POST', body })),
  dismiss: (id: string) => changesRequests(api<void>(`/ilchon-requests/${segment(id)}`, { method: 'DELETE' })),
};

/** The public lists change only when an admin publishes, so an island opened soon after another reuses them. */
const CATALOG_REUSE_MS = 60_000;
const catalogLists = new Map<string, { at: number; read: Promise<{ items: CatalogItem[] }> }>();

/**
 * Admin screens read and change what the public lists show. Whatever they ask, and however it ends (an answer lost on
 * the way may still have been applied), the next public read goes to the server.
 */
const admin = <T>(call: Promise<T>) => call.finally(() => catalogLists.clear());

export const catalogApi = {
  /**
   * Reuses a list read in the last minute, and a read still on its way; `fresh` always asks the server.
   * A failed read is not kept.
   */
  items: (kind?: CatalogKind, { fresh = false }: { fresh?: boolean } = {}) => {
    const key = kind ?? '';
    const known = catalogLists.get(key);
    if (!fresh && known && Date.now() - known.at < CATALOG_REUSE_MS) return known.read;
    const read = api<{ items: CatalogItem[] }>(`/catalog/items${kind ? `?kind=${kind}` : ''}`);
    const entry = { at: Date.now(), read };
    catalogLists.set(key, entry);
    entry.read.catch(() => {
      if (catalogLists.get(key) === entry) catalogLists.delete(key);
    });
    return entry.read;
  },
  adminItems: () => admin(api<{ items: AdminCatalogItem[] }>('/catalog/admin/items')),
  patch: (id: string, body: CatalogChanges) =>
    admin(api<AdminCatalogItem>(`/catalog/admin/items/${segment(id)}`, { method: 'PATCH', body })),
  /** Queues a copy and answers at once; follow it with `imports`. */
  importFactory: (body: FactoryImport) => admin(api<CatalogImport>('/catalog/admin/import', { method: 'POST', body })),
  factoryCharacters: () => api<{ characters: FactoryCharacter[] }>('/catalog/admin/factory-characters'),
  factoryUsage: () => api<FactoryUsage>('/catalog/admin/factory-usage'),
  studioPower: () => api<StudioPower>('/catalog/admin/studio-power'),
  /** Starts the studio's instance when it is stopped; answers its state after that. */
  startStudio: () => api<StudioPower>('/catalog/admin/studio-power', { method: 'POST' }),
  /** An import ends on its own time, so every look at the imports also drops the reused lists. */
  imports: (limit = 30) => admin(api<{ imports: CatalogImport[] }>(`/catalog/admin/imports?limit=${limit}`)),
  versions: (id: string) => api<{ versions: CatalogVersion[] }>(`/catalog/admin/items/${segment(id)}/versions`),
  rollback: (id: string, versionId: number) =>
    admin(api<AdminCatalogItem>(`/catalog/admin/items/${segment(id)}/rollback`, { method: 'POST', body: { versionId } })),
  bulkStatus: (ids: string[], status: CatalogStatus) =>
    admin(api<{ items: AdminCatalogItem[] }>('/catalog/admin/bulk-status', { method: 'POST', body: { ids, status } })),
};

/** The caller's own character from the wardrobe; each member reaches only theirs. */
export const lookApi = {
  mine: (signal?: AbortSignal) => api<{ look: Look | null }>('/looks/me', { signal }),
  /** Saves it and starts assembling it; poll `mine` until it is no longer `baking`. */
  save: (body: LookRequest) => api<{ look: Look }>('/looks/me', { method: 'PUT', body }),
  wear: (worn: boolean) => api<{ look: Look }>('/looks/me', { method: 'PATCH', body: { worn } }),
};

export const layoutApi = {
  capabilities: (signal?: AbortSignal) => api<LayoutCapabilities>('/studio/layouts/capabilities', { signal }),
  interpret: (body: LayoutInterpretInput, signal?: AbortSignal) =>
    api<LayoutInterpretation>('/studio/layouts/interpret', {
      method: 'POST', body, signal, timeoutMs: 60_000,
      headers: body.requestId ? { 'Idempotency-Key': body.requestId } : undefined,
    }),
};
