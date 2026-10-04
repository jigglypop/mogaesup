/** The Rust server's JSON, as `server/src` writes it. */

export type Role = 'user' | 'admin';

/** What the server checks (`server/src/rebac.rs`); admins hold every one. */
export type PermissionName = 'admin' | 'paid_operator' | 'operator' | 'moderator' | 'catalog_editor' | 'studio_viewer';

export type User = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /** Sent with sign-in and `/auth/me`. */
  permissions?: PermissionName[];
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

/** The island list is newest first: `before` is the last island's `updatedAt`, `q` a search in names and titles. */
export type HomeListQuery = { limit?: number; before?: string; q?: string };

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

/** A save's answer: the stored world without the island it sent. */
export type SavedHomeWorld = Pick<HomeWorld, 'worldId' | 'revision' | 'updatedAt'>;

export type SaveHomeWorld = {
  expectedOwnerId: string;
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

/** 미니미 are what people walk as, 주민 (`npc`) stand on islands, furniture is placed. */
export type CatalogKind = 'minime' | 'furniture' | 'npc';
export type CatalogStatus = 'draft' | 'published' | 'retired';

export type CatalogItem = {
  id: string;
  kind: CatalogKind;
  label: string;
  emoji: string;
  modelUrl: string;
  /** A small picture for the picker; characters copied from the character server have one. */
  thumbnailUrl: string | null;
  /** Engine clip names the model plays (idle, walk, run, …), recorded when it was copied in. */
  clips: string[];
  source: 'builtin' | 'factory';
  sourceRef: string | null;
  status: CatalogStatus;
  sortOrder: number;
};

export type CatalogChanges = Partial<Pick<CatalogItem, 'label' | 'emoji' | 'status' | 'sortOrder'>>;

/** Copies a finished character-server character into the catalog under `id`; the server picks its sealed version. */
export type FactoryImport = Pick<CatalogItem, 'id' | 'kind' | 'label' | 'emoji'> & {
  factoryJobId: string;
  status?: CatalogStatus;
  sortOrder?: number;
};

/** Why a catalog copy is behind its character: remade in another job, sealed again, another face, or a later stage. */
export type CatalogFreshness = 'current' | 'newJob' | 'newVersion' | 'newFace' | 'newStage';

/** The catalog item copying a studio character, as the character listing shows it. */
export type ImportedCopy = {
  id: string;
  /** Missing from servers older than 주민. */
  kind?: CatalogKind;
  label: string;
  emoji: string;
  status: CatalogStatus;
  thumbnailUrl: string | null;
  sourceRef: string | null;
  /** The copy is of the character's latest job, assembly, face and stage. */
  current: boolean;
  freshness: CatalogFreshness;
};

/** A finished character on the character server (backend/). */
export type FactoryCharacter = {
  jobId: string;
  characterId: string | null;
  name: string;
  version: string;
  /** `complete` has its face baked in; `expressions` is sealed with the face still being made. */
  stage: 'complete' | 'expressions';
  createdAt: string | null;
  /** The front render, through the admin proxy. */
  thumbnailUrl: string;
  /** The chosen face (expression id); null when none is chosen or the character server could not say. */
  face: string | null;
  faceKnown: boolean;
  /** `job/version[/face]`: what an import would copy now. */
  sourceRef: string;
  /** The playable model an import would copy, through the admin proxy. */
  modelUrl: string;
  /** The item copying this character (matched by character, so a remade job is the same item). */
  imported: ImportedCopy | null;
  /** Other items copying the same character. */
  otherItems: string[];
};

/** The character studio's EC2 instance, which powers itself off when idle (`STUDIO_INSTANCE_ID`; absent in local runs). */
export type StudioPower =
  | { configured: false }
  | { configured: true; instanceId: string; state: 'pending' | 'running' | 'stopping' | 'stopped' | (string & {}) };

/** How far the studio screens reach through the server (`FACTORY_ACCESS`), and this month's paid requests. */
export type FactoryUsage =
  | { connected: false }
  | { connected: true; access: 'read' | 'write' | 'paid'; paidThisMonth: number; paidMonthly: number };

/** Admin listing rows: the item, where it came from, its versions and how many homes wear it. */
export type AdminCatalogItem = CatalogItem & {
  characterId: string | null;
  versionId: number | null;
  versionCount: number;
  /** Homes whose 미니미 this is (0 for furniture). */
  usage: number;
  updatedAt: string;
};

export type ImportStatus = 'queued' | 'running' | 'done' | 'failed';
export type ImportStep = 'queued' | 'source' | 'download' | 'verify' | 'slim' | 'store' | 'thumbnail' | 'save' | 'done';
export type CheckLevel = 'ok' | 'info' | 'warning' | 'error';
export type ReportCheck = { code: string; level: CheckLevel; message: string };

/** One image a model embeds; sizes are null when the server could not read them. */
export type ModelTexture = {
  image: number;
  mime: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
};

/** Everything an import checked; kept with the import and the version it made. */
export type ImportReport = {
  checks: ReportCheck[];
  source?: {
    jobId: string;
    version: string;
    face: string | null;
    stage: string | null;
    characterId: string | null;
    modelPath: string;
  };
  file?: { sha256: string; expectedSha256: string | null; bytes: number; webBytes: number | null; slimmed: boolean | null };
  model?: {
    skinned: boolean;
    joints: number;
    clips: string[];
    animations: string[];
    meshes: number;
    materials: number;
    triangles: number;
    vertices: number;
    /** Width, height and depth in metres. */
    size: [number, number, number] | null;
    textures: ModelTexture[];
  };
  /** The stored copy's textures, after shrinking. */
  webTextures?: ModelTexture[];
  thumbnail?: { ok: boolean; width?: number; height?: number };
  outcome?: 'created' | 'updated' | 'unchanged';
};

/** A copy from the character server running in the background; poll it until `done` or `failed`. */
export type CatalogImport = {
  id: string;
  itemId: string;
  kind: CatalogKind;
  label: string;
  emoji: string;
  factoryJobId: string;
  characterId: string | null;
  /** The item existed when the import was queued: an update. */
  replaces: boolean;
  status: ImportStatus;
  step: ImportStep;
  progress: number;
  detail: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  report: ImportReport | null;
  versionId: number | null;
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

/** A model a catalog item has shown; any of them can be put back. */
export type CatalogVersion = {
  id: number;
  current: boolean;
  modelUrl: string;
  thumbnailUrl: string | null;
  clips: string[];
  sourceRef: string | null;
  characterId: string | null;
  stage: string | null;
  report: ImportReport | null;
  importId: string | null;
  createdBy: string | null;
  createdAt: string;
};

/** A wardrobe part a look wears: the very file the wardrobe listed. */
export type LookPartRef = { jobId: string; version: string; sha256: string };

/** Rest geometry adjustment in the body's metre coordinates, around the part's bounds centre. */
export type LookPartEdit = { scale: [number, number, number]; translation: [number, number, number] };

export type LayoutInterpretInput = { description: string; mode: 'rules' | 'ai'; requestId?: string };
export type LayoutCapabilities = { rules: boolean; ai: boolean };
export type LayoutInterpretation = {
  kind: 'cafe' | 'shop' | 'office';
  widthCells: number;
  depthCells: number;
  seats: number;
  floorPresetId: string;
  wallPresetId: string;
  interpretation: 'rules' | 'ai';
  warnings: string[];
};

/** What a member dressed their character in: a wardrobe body, a part per slot, hair and garment region colours. */
export type LookRequest = {
  body: { jobId: string; version: string };
  parts: Record<string, LookPartRef>;
  partEdits?: Record<string, LookPartEdit>;
  hairColor: string | null;
  /** Per garment slot, region index ("0"–"3") to `#rrggbb`. */
  colors: Record<string, Record<string, string>>;
};

/**
 * A member's own character. The server assembles the request into one model; `modelUrl` is the last one it finished,
 * kept while a newer request is `baking` or after one `failed`. The island wears it while `worn` is on.
 */
export type Look = {
  request: LookRequest;
  status: 'baking' | 'ready' | 'failed';
  worn: boolean;
  modelUrl: string | null;
  error: { code: string; message: string } | null;
  updatedAt: string;
};
