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
  ProfileChanges,
  RealtimeTicket,
  Registration,
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
  update: (body: ProfileChanges) => api<HomeView>('/homes/me', { method: 'PATCH', body }),
  visit: (username: string, visitorId: string) =>
    api<VisitCounter>(`/homes/${segment(username)}/visits`, { method: 'POST', body: { visitorId } }),
  /** Undefined until the owner first saves. */
  world: (username: string, worldId: string) =>
    api<HomeWorld | undefined>(`/homes/${segment(username)}/world?worldId=${segment(worldId)}`),
  /** An island is up to 2MB, so a save may take longer than other requests before it counts as unanswered. */
  saveWorld: (body: SaveHomeWorld) => api<HomeWorld>('/homes/me/world', { method: 'PUT', body, timeoutMs: 60_000 }),
};

export const socialApi = {
  guestbook: (username: string, before?: string) =>
    api<GuestbookPage>(`/homes/${segment(username)}/guestbook${before ? `?before=${segment(before)}` : ''}`),
  write: (username: string, body: { body: string; secret: boolean }) =>
    api<{ id: string }>(`/homes/${segment(username)}/guestbook`, { method: 'POST', body }),
  remove: (id: string) => api<void>(`/guestbook/${segment(id)}`, { method: 'DELETE' }),
  ilchons: (username: string) => api<{ ilchons: Ilchon[] }>(`/homes/${segment(username)}/ilchons`),
  status: (username: string) => api<IlchonStatus>(`/ilchon/${segment(username)}`),
  request: (username: string, body: IlchonAsk) =>
    api<{ relation: 'requested' }>(`/ilchon/${segment(username)}/request`, { method: 'POST', body }),
  unlink: (username: string) => api<void>(`/ilchon/${segment(username)}`, { method: 'DELETE' }),
  requests: () => api<{ received: IlchonRequest[]; sent: IlchonRequest[] }>('/ilchon-requests'),
  accept: (id: string, body: { name?: string }) =>
    api<IlchonStatus>(`/ilchon-requests/${segment(id)}/accept`, { method: 'POST', body }),
  dismiss: (id: string) => api<void>(`/ilchon-requests/${segment(id)}`, { method: 'DELETE' }),
};

export const catalogApi = {
  items: (kind?: CatalogKind) => api<{ items: CatalogItem[] }>(`/catalog/items${kind ? `?kind=${kind}` : ''}`),
  adminItems: () => api<{ items: AdminCatalogItem[] }>('/catalog/admin/items'),
  patch: (id: string, body: CatalogChanges) =>
    api<AdminCatalogItem>(`/catalog/admin/items/${segment(id)}`, { method: 'PATCH', body }),
  /** Queues a copy and answers at once; follow it with `imports`. */
  importFactory: (body: FactoryImport) => api<CatalogImport>('/catalog/admin/import', { method: 'POST', body }),
  factoryCharacters: () => api<{ characters: FactoryCharacter[] }>('/catalog/admin/factory-characters'),
  factoryUsage: () => api<FactoryUsage>('/catalog/admin/factory-usage'),
  studioPower: () => api<StudioPower>('/catalog/admin/studio-power'),
  /** Starts the studio's instance when it is stopped; answers its state after that. */
  startStudio: () => api<StudioPower>('/catalog/admin/studio-power', { method: 'POST' }),
  imports: (limit = 30) => api<{ imports: CatalogImport[] }>(`/catalog/admin/imports?limit=${limit}`),
  versions: (id: string) => api<{ versions: CatalogVersion[] }>(`/catalog/admin/items/${segment(id)}/versions`),
  rollback: (id: string, versionId: number) =>
    api<AdminCatalogItem>(`/catalog/admin/items/${segment(id)}/rollback`, { method: 'POST', body: { versionId } }),
  bulkStatus: (ids: string[], status: CatalogStatus) =>
    api<{ items: AdminCatalogItem[] }>('/catalog/admin/bulk-status', { method: 'POST', body: { ids, status } }),
};

/** The caller's own character from the wardrobe; each member reaches only theirs. */
export const lookApi = {
  mine: () => api<{ look: Look | null }>('/looks/me'),
  /** Saves it and starts assembling it; poll `mine` until it is no longer `baking`. */
  save: (body: LookRequest) => api<{ look: Look }>('/looks/me', { method: 'PUT', body }),
  wear: (worn: boolean) => api<{ look: Look }>('/looks/me', { method: 'PATCH', body: { worn } }),
};
