import { api } from './client';
import type {
  CatalogChanges,
  CatalogItem,
  CatalogKind,
  Credentials,
  FactoryCharacter,
  FactoryImport,
  FactoryUsage,
  GuestbookPage,
  HomeSummary,
  HomeView,
  HomeWorld,
  Ilchon,
  IlchonAsk,
  IlchonRequest,
  IlchonStatus,
  ProfileChanges,
  RealtimeTicket,
  Registration,
  SaveHomeWorld,
  User,
  VisitCounter,
} from './types';

const segment = encodeURIComponent;

export const authApi = {
  me: () => api<{ user: User | null }>('/auth/me'),
  register: (body: Registration) => api<{ user: User }>('/auth/register', { method: 'POST', body }),
  login: (body: Credentials) => api<{ user: User }>('/auth/login', { method: 'POST', body }),
  logout: () => api<void>('/auth/logout', { method: 'POST' }),
  realtimeTicket: () => api<RealtimeTicket>('/auth/realtime-ticket', { method: 'POST' }),
};

export const homeApi = {
  list: () => api<{ homes: HomeSummary[] }>('/homes'),
  get: (username: string) => api<HomeView>(`/homes/${segment(username)}`),
  /** The caller's own home, created on the spot if it is missing. */
  mine: () => api<HomeView>('/homes/me'),
  update: (body: ProfileChanges) => api<HomeView>('/homes/me', { method: 'PATCH', body }),
  visit: (username: string, visitorId: string) =>
    api<VisitCounter>(`/homes/${segment(username)}/visits`, { method: 'POST', body: { visitorId } }),
  /** Undefined until the owner first saves. */
  world: (username: string, worldId: string) =>
    api<HomeWorld | undefined>(`/homes/${segment(username)}/world?worldId=${segment(worldId)}`),
  saveWorld: (body: SaveHomeWorld) => api<HomeWorld>('/homes/me/world', { method: 'PUT', body }),
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
  adminItems: () => api<{ items: CatalogItem[] }>('/catalog/admin/items'),
  patch: (id: string, body: CatalogChanges) =>
    api<CatalogItem>(`/catalog/admin/items/${segment(id)}`, { method: 'PATCH', body }),
  importFactory: (body: FactoryImport) => api<CatalogItem>('/catalog/admin/import', { method: 'POST', body }),
  factoryCharacters: () => api<{ characters: FactoryCharacter[] }>('/catalog/admin/factory-characters'),
  factoryUsage: () => api<FactoryUsage>('/catalog/admin/factory-usage'),
};
