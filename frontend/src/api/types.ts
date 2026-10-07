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
/** `POST /api/auth/password`; the new one is 10 to 128 characters, as at sign-up. */
export type PasswordChange = { currentPassword: string; newPassword: string };

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
  /** The picture the island's link preview shows (a stored 1200×630 JPEG); null or missing for the site's own. */
  thumbnailUrl?: string | null;
  /** The speech balloon the owner talks in on every island (minihome/balloons/designs.json); missing from older servers. */
  balloon?: string;
};

export type VisitCounter = { today: number; total: number };

export type HomeView = {
  profile: HomeProfile;
  visits: VisitCounter;
  isOwner: boolean;
};

export type HomeSummary = Pick<HomeProfile, 'username' | 'ownerName' | 'title' | 'statusMessage' | 'emoji' | 'updatedAt'> & {
  total: number;
  /** The owner's id, the next page's `beforeId`; missing from a server older than it. */
  ownerId?: string;
};

/**
 * The island list is newest first: `before` is the last island's `updatedAt` and `beforeId` its `ownerId`, which tells
 * islands saved at the same time apart; `q` a search in names and titles.
 */
export type HomeListQuery = { limit?: number; before?: string; beforeId?: string; q?: string };

export type ProfileChanges = Partial<
  Pick<HomeProfile, 'title' | 'statusMessage' | 'mood' | 'minime' | 'emoji' | 'visibility' | 'balloon'>
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
  | {
      connected: true;
      access: 'read' | 'write' | 'paid';
      paidThisMonth: number;
      paidMonthly: number;
      /**
       * Whether members' wardrobe reads reach the character server narrowed to what members may see (FACTORY_JWT_SECRET
       * is set); false while they go as the server's own. Absent from servers before it was told.
       */
      memberScope?: boolean;
    };

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

/** A dog anyone may adopt (`GET /api/pets/breeds`, published ones only). */
export type PetBreed = {
  id: string;
  label: string;
  emoji: string;
  modelUrl: string;
  thumbnailUrl: string | null;
  /** Engine clip names the model plays (idle, walk, run, sit_hold, …). */
  clips: string[];
  /** Metres from the ground to the top of the ears in the first frame of idle: the engine template's height. */
  heightM: number;
};

/** A breed as the catalog's editors see it (`/api/pets/admin/breeds`). */
export type AdminPetBreed = PetBreed & {
  species: 'dog';
  status: CatalogStatus;
  sortOrder: number;
  source: 'builtin' | 'factory';
  sourceRef: string | null;
  /** Pets of this breed. */
  pets: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminPetBreedChanges = Partial<Pick<AdminPetBreed, 'label' | 'emoji' | 'status' | 'sortOrder' | 'heightM'>>;

/** A model the app ships (`/gltf/pets/<slug>.glb`, its picture beside it) offered as a breed; a draft unless `status`. */
export type PetBreedRegistration = Pick<PetBreed, 'id' | 'label' | 'modelUrl' | 'thumbnailUrl' | 'clips'> & {
  emoji?: string;
  heightM?: number;
  status?: CatalogStatus;
  sortOrder?: number;
};

/** Where a pet rests while its owner is away, on the island's ground. */
export type PetHome = { x: number; z: number };

/** A pet as anyone who may see its island sees it (`GET /api/homes/{username}/pet`). */
export type IslandPet = { id: string; name: string; breed: string; breedInfo: PetBreed; home: PetHome };

/** Drives, each 0..1 (all four when saved); `{}` for a new pet. */
export type PetDrivesRecord = Partial<Record<'energy' | 'satiety' | 'mood' | 'bond', number>>;
/** One command's training: times given, feedback that answered it, and mastery in percent. */
export type PetCommandStats = Partial<Record<'given' | 'treats' | 'praises' | 'scolds' | 'mastery', number>>;
/** Training counts, whole numbers under the keys the server accepts (`server/src/pets.rs`). */
export type PetStatsRecord = Partial<Record<'treats' | 'praises' | 'pats' | 'scolds' | 'bondDay' | 'bondGainedMilli', number>> & {
  commands?: Partial<Record<'come' | 'sit' | 'down' | 'stay' | 'fetch' | 'speak' | 'jump', PetCommandStats>>;
};

/** The owner's own pet (`GET /api/pets/me`), with what its training changed. */
export type MyPet = IslandPet & {
  seed: number;
  graphId: string;
  /** `pet-brain-v1`. */
  model: string;
  /** The `pet-brain-v1` bytes in standard base64; null until the first save. */
  brain: string | null;
  drives: PetDrivesRecord;
  stats: PetStatsRecord;
  /** The revision the next brain save names. */
  revision: number;
  createdAt: string;
  /** When the brain, drives and stats were last saved (the adoption until then): the time the drives are as of. */
  updatedAt: string;
};

export type PetAdoption = { breedId: string; name: string; home: PetHome; expectedOwnerId: string };
/** `petId`: the pet the page has; a change meant for another one is refused. */
export type PetChanges = { name?: string; home?: PetHome; expectedOwnerId: string; petId?: string };
export type PetBrainSave = {
  revision: number;
  brain: string;
  drives: Required<PetDrivesRecord>;
  stats: PetStatsRecord;
  expectedOwnerId: string;
  petId?: string;
};
export type SavedPetBrain = { revision: number; updatedAt: string };
