import { sessionEpoch } from '../auth/sessionWork';
import { request } from '../character/api';
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
  PasswordChange,
  PasswordConfirm,
  ProfileChanges,
  RealtimeTicket,
  Registration,
  ReadingChart,
  SajuBirth,
  DecorFlag,
  DecorItem,
  FlagDesign,
  GiftDesign,
  HouseChoice,
  PhotoBoard,
  SajuDecor,
  Terrain,
  TerrainCell,
  SharedIsland,
  SajuHome,
  SajuPictureState,
  SajuReadingState,
  SajuVillage,
  SavedHomeWorld,
  SaveHomeWorld,
  StudioPower,
  User,
  VisitCounter,
} from './types';
import type {
  AdminPetBreed,
  AdminPetBreedChanges,
  IslandPet,
  MyPet,
  PetAdoption,
  PetBrainSave,
  PetBreed,
  PetBreedRegistration,
  PetChanges,
  SavedPetBrain,
} from './types';

const segment = encodeURIComponent;

/** `/homes` with only the paging and search that are set; `beforeId` goes only with the `before` it belongs to. */
export function homesPath({ limit, before, beforeId, q }: HomeListQuery = {}): string {
  const query = new URLSearchParams();
  if (limit) query.set('limit', String(limit));
  if (before) {
    query.set('before', before);
    if (beforeId) query.set('beforeId', beforeId);
  }
  if (q) query.set('q', q);
  const text = query.toString();
  return text ? `/homes?${text}` : '/homes';
}

export const authApi = {
  me: () => api<{ user: User | null }>('/auth/me'),
  register: (body: Registration) => api<{ user: User }>('/auth/register', { method: 'POST', body }),
  login: (body: Credentials) => api<{ user: User }>('/auth/login', { method: 'POST', body }),
  logout: () => api<void>('/auth/logout', { method: 'POST' }),
  /**
   * 204 once the password is changed; `wrong_password` when the current one is not it. Every session ends, this one
   * too: the answer brings this browser a new one, and its realtime sockets connect again.
   */
  changePassword: (body: PasswordChange) => api<void>('/auth/password', { method: 'POST', body, startsOver: true }),
  /**
   * Ends every other session of the member once the current password is checked; `ended` counts them. The answer may
   * bring this browser a new session cookie too, so a refusal of the old one meanwhile is not a sign-out (`startsOver`).
   */
  logoutOthers: (body: PasswordConfirm) => api<{ ended: number }>('/auth/logout-others', { method: 'POST', body, startsOver: true }),
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
  /** The owner's profile picture: a JPEG or PNG data URL, which the server crops to a square and encodes again. */
  setAvatar: (body: { expectedOwnerId: string; image: string }) => api<HomeView>('/homes/me/avatar', { method: 'PUT', body, timeoutMs: 60_000 }),
  removeAvatar: (body: { expectedOwnerId: string }) => api<HomeView>('/homes/me/avatar', { method: 'DELETE', body }),
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
  /** Every note `author` left on `username`'s guestbook, removed by its owner (or a moderator). */
  removeByAuthor: (username: string, author: string) =>
    api<{ deleted: number }>(`/homes/${segment(username)}/guestbook?author=${segment(author)}`, { method: 'DELETE' }),
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
  /** Dismisses every 이웃 request the viewer received. */
  dismissAll: () => changesRequests(api<{ dismissed: number }>('/ilchon-requests', { method: 'DELETE' })),
};

export const sajuApi = {
  /** A member's 사주 home and their village. */
  village: (username: string) => api<SajuVillage>(`/homes/${segment(username)}/saju`),
  /** Builds the caller's home, or builds it again from a corrected name or birth. */
  save: (body: { expectedOwnerId: string; name: string; birth: SajuBirth }) => api<{ saju: SajuHome }>('/homes/me/saju', { method: 'PUT', body }),
  /** Takes the caller's home down; their guestbook and 이웃 stay. */
  remove: (body: { expectedOwnerId: string }) => api<void>('/homes/me/saju', { method: 'DELETE', body }),
  /** A home's reading, as far as it has been written. */
  reading: (username: string) => api<SajuReadingState>(`/homes/${segment(username)}/saju/reading`),
  /**
   * Asks for the caller's reading to be written from `chart` (202 pending; 200 with the one already written for this
   * birth unless `again`). Refused 409 `stale_birth` when the chart's birth is not the stored one.
   */
  read: (body: { expectedOwnerId: string; chart: ReadingChart; again?: boolean }) =>
    api<SajuReadingState>('/homes/me/saju/reading', { method: 'POST', body }),
  /** A home's 미연시 picture, as far as it has been drawn. */
  picture: (username: string) => api<SajuPictureState>(`/homes/${segment(username)}/saju/picture`),
  /**
   * Asks for the caller's island to be drawn again from `image`: a `data:image/webp;base64,…` (or png/jpeg) of the island
   * alone, 1024×1024 (202 pending; 200 with the one already drawn for this birth unless `again`).
   */
  draw: (body: { expectedOwnerId: string; image: string; again?: boolean }) =>
    api<SajuPictureState>('/homes/me/saju/picture', { method: 'POST', body, timeoutMs: 60_000 }),
  /** What is placed on a 섬, and the flags given to it. */
  decor: (username: string) => api<SajuDecor>(`/homes/${segment(username)}/saju/decor`),
  uploadPhotoBoard: (expectedOwnerId: string, image: string) =>
    api<PhotoBoard>('/homes/me/saju/photo-board', { method: 'PUT', body: { expectedOwnerId, image } }),
  removePhotoBoard: (expectedOwnerId: string) =>
    api<void>('/homes/me/saju/photo-board', { method: 'DELETE', body: { expectedOwnerId } }),
  /** Places what the caller's 섬 shows (at most 24 things); refused 409 `no_home` before the home is built. */
  placeDecor: (body: { expectedOwnerId: string; items: DecorItem[] }) => api<SajuDecor>('/homes/me/saju/decor', { method: 'PUT', body }),
  setTerrain: (body: { expectedOwnerId: string; terrain?: Terrain; tiles?: TerrainCell[] }) => api<SajuDecor>('/homes/me/saju/terrain', { method: 'PUT', body }),
  /** The house the owner's home is built as; null builds the one their chart gives again. */
  setHouse: (body: { expectedOwnerId: string; house: HouseChoice | null }) => api<SajuDecor>('/homes/me/saju/house', { method: 'PUT', body }),
  /** Gives a member's 섬 the caller's flag: once a day for each 섬 (409 `already_given`), not one's own (400 `own_home`). */
  giveFlag: (username: string, design: FlagDesign) => api<DecorFlag>(`/homes/${segment(username)}/saju/flags`, { method: 'POST', body: { design } }),
  giveGift: (username: string, body: { expectedGiverId: string; giverBirth: SajuBirth; recipientBirth: SajuBirth; giverPillars: string[]; recipientPillars: string[]; design: GiftDesign; x?: number; z?: number }) =>
    api<void>(`/homes/${segment(username)}/saju/gifts`, { method: 'POST', body }),
  islands: () => api<{ islands: SharedIsland[] }>('/islands'),
  island: (slug: string) => api<SharedIsland>(`/islands/${segment(slug)}`),
  createIsland: (title: string) => api<SharedIsland>('/islands', { method: 'POST', body: { title } }),
  /** Takes down a flag given to the caller's 섬, and wherever it was placed. */
  dropFlag: (id: string) => api<void>(`/homes/me/saju/flags/${segment(id)}`, { method: 'DELETE' }),
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
  /**
   * Saves it and starts assembling it; poll `mine` until it is no longer `baking`. The server reads the wardrobe from the
   * character server first, so a save may take longer than other requests before it counts as unanswered.
   */
  save: (body: LookRequest) => api<{ look: Look }>('/looks/me', { method: 'PUT', body, timeoutMs: 60_000 }),
  wear: (worn: boolean) => api<{ look: Look }>('/looks/me', { method: 'PATCH', body: { worn } }),
};

/**
 * Store layouts are the character server's, reached through the app server, so they take the studio's client: it reads
 * the character server's `{error: {code, message}}` as well as the app server's `{code, message}`, and turns a lost
 * connection into its own words.
 */
export const layoutApi = {
  capabilities: (signal?: AbortSignal) => request<LayoutCapabilities>('/api/studio/layouts/capabilities', { signal }),
  interpret: (body: LayoutInterpretInput, signal?: AbortSignal) =>
    request<LayoutInterpretation>('/api/studio/layouts/interpret', {
      method: 'POST', body: JSON.stringify(body), signal, timeoutMs: 60_000,
      headers: { 'Content-Type': 'application/json', ...(body.requestId ? { 'Idempotency-Key': body.requestId } : {}) },
    }),
};

/** Island pets (`server/src/pets.rs`): each member keeps one dog; its owner's page trains it and saves what changed. */
export const petApi = {
  breeds: (signal?: AbortSignal) => api<{ breeds: PetBreed[] }>('/pets/breeds', { signal }),
  /** The pet of `username`'s island, for anyone who may see the island. */
  island: (username: string, signal?: AbortSignal) => api<{ pet: IslandPet | null }>(`/homes/${segment(username)}/pet`, { signal }),
  mine: (signal?: AbortSignal) => api<{ pet: MyPet | null }>('/pets/me', { signal }),
  adopt: (body: PetAdoption) => api<{ pet: MyPet }>('/pets/me', { method: 'POST', body }),
  update: (body: PetChanges) => api<{ pet: MyPet }>('/pets/me', { method: 'PATCH', body }),
  /** `keepalive` for the save a page sends as it is hidden or left (the body stays far under the browser's 64 KB). */
  saveBrain: (body: PetBrainSave, { keepalive = false }: { keepalive?: boolean } = {}) =>
    api<SavedPetBrain>('/pets/me/brain', { method: 'PUT', body, keepalive }),
  release: (body: { expectedOwnerId: string; petId?: string }) => api<void>('/pets/me', { method: 'DELETE', body }),
  adminBreeds: () => api<{ breeds: AdminPetBreed[] }>('/pets/admin/breeds'),
  patchBreed: (id: string, body: AdminPetBreedChanges) =>
    api<AdminPetBreed>(`/pets/admin/breeds/${segment(id)}`, { method: 'PATCH', body }),
  registerBreed: (body: PetBreedRegistration) => api<AdminPetBreed>('/pets/admin/breeds', { method: 'POST', body }),
};
