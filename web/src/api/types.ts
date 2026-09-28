/** The Rust server's JSON, as `server/src` writes it. */

export type Role = 'user' | 'admin';

export type User = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
};

export type Credentials = { username: string; password: string };
export type Registration = Credentials & { displayName: string };

/** A single-use pass into a live room; `expiresAt` is in epoch seconds, a minute after issue. */
export type RealtimeTicket = { ticket: string; expiresAt: number; user: User };

/** Someone as pages show them: name and their 미니미 emoji. */
export type UserCard = {
  id: string;
  username: string;
  displayName: string;
  emoji: string;
};

export const MOOD_COUNT = 4;
export type HomeVisibility = 'public' | 'ilchon' | 'private';

export type HomeProfile = {
  ownerId: string;
  username: string;
  ownerName: string;
  title: string;
  statusMessage: string;
  mood: number;
  minime: string;
  emoji: string;
  visibility: HomeVisibility;
  updatedAt: string;
};

export type VisitCounter = { today: number; total: number };

export type HomeView = {
  profile: HomeProfile;
  visits: VisitCounter;
  isOwner: boolean;
};

export type HomeSummary = Pick<HomeProfile, 'username' | 'ownerName' | 'title' | 'statusMessage' | 'emoji' | 'updatedAt'> & {
  total: number;
};

export type ProfileChanges = Partial<
  Pick<HomeProfile, 'title' | 'statusMessage' | 'mood' | 'minime' | 'emoji' | 'visibility'>
>;

/** The runtime's save envelope for one world, stored as-is; the server only owns its revision. */
export type HomeWorld = {
  worldId: string;
  revision: number;
  data: Record<string, unknown>;
  updatedAt: string;
};

export type SaveHomeWorld = {
  worldId: string;
  baseRevision: number;
  data: Record<string, unknown>;
};

export type GuestbookEntry = {
  id: string;
  author: UserCard;
  /** Empty for a secret entry the viewer may not read. */
  body: string;
  secret: boolean;
  createdAt: string;
  canDelete: boolean;
};

export type GuestbookPage = {
  entries: GuestbookEntry[];
  total: number;
  nextBefore: string | null;
};

export type IlchonRelation = 'self' | 'none' | 'requested' | 'received' | 'ilchon';

export type Ilchon = {
  user: UserCard;
  name: string;
  theirName: string;
  since: string;
};

/** `name` is what the requester calls the other person; `theirName` is what they propose to be called back. */
export type IlchonAsk = { name: string; theirName: string; message: string };

export type IlchonRequest = IlchonAsk & {
  id: string;
  from: UserCard;
  to: UserCard;
  createdAt: string;
};

export type IlchonStatus = {
  relation: IlchonRelation;
  ilchon: Ilchon | null;
  request: IlchonRequest | null;
};

export type CatalogKind = 'minime' | 'furniture';
export type CatalogStatus = 'draft' | 'published' | 'retired';

export type CatalogItem = {
  id: string;
  kind: CatalogKind;
  label: string;
  emoji: string;
  modelUrl: string;
  source: 'builtin' | 'factory';
  sourceRef: string | null;
  status: CatalogStatus;
  sortOrder: number;
};

export type CatalogChanges = Partial<Pick<CatalogItem, 'label' | 'emoji' | 'status' | 'sortOrder'>>;

/** Copies a sealed character-server assembly (`native-parts/<version>/model.glb`) into the catalog under `id`. */
export type FactoryImport = Pick<CatalogItem, 'id' | 'kind' | 'label' | 'emoji'> & {
  factoryJobId: string;
  factoryVersion: string;
  status?: CatalogStatus;
  sortOrder?: number;
};
