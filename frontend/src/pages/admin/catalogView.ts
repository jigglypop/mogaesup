// What the admin screens show, worked out from the API's data without React, so it can be tested on its own.
import type {
  AdminCatalogItem,
  CatalogFreshness,
  CatalogImport,
  CatalogKind,
  CatalogStatus,
  CheckLevel,
  FactoryCharacter,
  ImportReport,
  ImportStep,
  ModelTexture,
} from '../../api/types';

export const STATUS_LABEL: Record<CatalogStatus, string> = { draft: '초안', published: '공개', retired: '내림' };
export const KIND_LABEL: Record<CatalogKind, string> = { minime: '미니미', furniture: '가구', npc: '주민' };
export const SOURCE_LABEL: Record<AdminCatalogItem['source'], string> = { builtin: '기본', factory: '캐릭터 스튜디오' };

export const LEVEL_LABEL: Record<CheckLevel, string> = { ok: '통과', info: '참고', warning: '주의', error: '문제' };

export const STAGE_LABEL: Record<FactoryCharacter['stage'], string> = {
  complete: '완성 · 표정 적용됨',
  expressions: '표정 준비 중 · 기본 조립본',
};

export function faceText(character: Pick<FactoryCharacter, 'face' | 'faceKnown'>): string {
  if (!character.faceKnown) return '표정 확인 못 함';
  return character.face ? `표정 ${character.face.slice(0, 8)}` : '표정 없음';
}

/** `2048×2048 PNG`, or what is known of it. */
export function textureText(texture: ModelTexture | undefined): string {
  if (!texture) return '—';
  const size = texture.width && texture.height ? `${texture.width}×${texture.height}` : '크기 모름';
  const kind = texture.mime?.replace('image/', '').toUpperCase();
  return [size, kind, formatBytes(texture.bytes)].filter(Boolean).join(' · ');
}

export const FRESHNESS_LABEL: Record<CatalogFreshness, string> = {
  current: '최신',
  newJob: '다시 만든 캐릭터가 있음',
  newVersion: '새 조립본이 있음',
  newFace: '표정이 바뀜',
  newStage: '스튜디오 단계가 바뀜',
};

/** The steps an import shows, in order; `done` is the end, not a step. */
const IMPORT_STEPS: readonly { step: ImportStep; label: string }[] = [
  { step: 'queued', label: '대기' },
  { step: 'source', label: '작업 확인' },
  { step: 'download', label: '모델 받기' },
  { step: 'verify', label: '검사' },
  { step: 'slim', label: '텍스처 줄이기' },
  { step: 'store', label: '저장' },
  { step: 'thumbnail', label: '대표 그림' },
  { step: 'save', label: '카탈로그 반영' },
];

type StepState = 'done' | 'active' | 'failed' | 'waiting';

/** Each step's state: finished before the current one, the current one running or failed, the rest waiting. */
export function stepStates(item: Pick<CatalogImport, 'status' | 'step'>): { step: ImportStep; label: string; state: StepState }[] {
  const at = IMPORT_STEPS.findIndex((entry) => entry.step === item.step);
  return IMPORT_STEPS.map((entry, index) => {
    let state: StepState = 'waiting';
    if (item.status === 'done' || at < 0 || index < at) state = 'done';
    else if (index === at) state = item.status === 'failed' ? 'failed' : 'active';
    return { ...entry, state };
  });
}

export const stepLabel = (step: ImportStep) =>
  step === 'done' ? '완료' : (IMPORT_STEPS.find((entry) => entry.step === step)?.label ?? step);

export const isActive = (item: Pick<CatalogImport, 'status'>) => item.status === 'queued' || item.status === 'running';

/** Imports that were running in `before` and have ended in `after`. */
export function finishedSince(before: readonly CatalogImport[], after: readonly CatalogImport[]): CatalogImport[] {
  const running = new Set(before.filter(isActive).map((item) => item.id));
  return after.filter((item) => running.has(item.id) && !isActive(item));
}

/** The running import of an item, or of a studio character (by job or character). */
export function activeImportFor(
  imports: readonly CatalogImport[],
  target: { itemId?: string; jobId?: string; characterId?: string | null },
): CatalogImport | undefined {
  return imports.find(
    (item) =>
      isActive(item) &&
      ((target.itemId !== undefined && item.itemId === target.itemId) ||
        (target.jobId !== undefined && item.factoryJobId === target.jobId) ||
        (!!target.characterId && item.characterId === target.characterId)),
  );
}

export function outcomeText(item: CatalogImport): string {
  if (item.status === 'failed') return item.errorMessage ?? '가져오지 못했어요';
  if (isActive(item)) return `${stepLabel(item.step)} 중`;
  switch (item.report?.outcome) {
    case 'created':
      return '새 항목으로 가져왔어요';
    case 'unchanged':
      return '바뀐 것이 없어 지금 버전을 그대로 둬요';
    default:
      return '모델을 새 버전으로 바꿨어요';
  }
}

export function reportCounts(report: ImportReport | null | undefined): { errors: number; warnings: number } {
  const checks = report?.checks ?? [];
  return {
    errors: checks.filter((check) => check.level === 'error').length,
    warnings: checks.filter((check) => check.level === 'warning').length,
  };
}

const MB = 1024 * 1024;

/** `7.1 MB`, `512 KB`, the way the server's messages count (1 MB = 1024² bytes). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  return bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export const formatCount = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : value.toLocaleString('ko-KR');

export function formatWhen(at: string | null | undefined): string {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Catalog ids are lowercase slugs of 2–64 characters; a character's job id gives it a stable one. */
export function suggestedId(character: Pick<FactoryCharacter, 'jobId'>): string {
  const slug = character.jobId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 12).replace(/^-+|-+$/g, '');
  return `char-${slug || 'new'}`;
}

export const CATALOG_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** Why a name or emoji cannot be saved, or null. Counts characters as the server does (code points). */
export function textProblem(value: string, max: number): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '비워 둘 수 없어요';
  if ([...trimmed].length > max) return `${max}자까지 쓸 수 있어요`;
  return null;
}

/** A whole number the server's sort order column holds, or null. */
export function parseSortOrder(value: string): number | null {
  const text = value.trim();
  if (!/^-?\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= -2147483648 && number <= 2147483647 ? number : null;
}

export type CharacterGroup = 'new' | 'update' | 'current';
/** `todo` is what still needs an import: new characters and newer versions. */
export type CharacterFilter = 'todo' | 'all' | CharacterGroup;

export const CHARACTER_FILTERS: readonly { value: CharacterFilter; label: string }[] = [
  { value: 'todo', label: '할 일' },
  { value: 'new', label: '새 캐릭터' },
  { value: 'update', label: '새 버전' },
  { value: 'current', label: '최신' },
  { value: 'all', label: '전체' },
];

export const characterGroup = (character: FactoryCharacter): CharacterGroup =>
  !character.imported ? 'new' : character.imported.current ? 'current' : 'update';

const matches = (query: string, ...fields: (string | null | undefined)[]) => {
  const needle = query.trim().toLowerCase();
  return !needle || fields.some((field) => field?.toLowerCase().includes(needle));
};

export function filterCharacters(characters: readonly FactoryCharacter[], filter: CharacterFilter, query: string) {
  return characters.filter(
    (character) =>
      (filter === 'all' || (filter === 'todo' ? characterGroup(character) !== 'current' : characterGroup(character) === filter)) &&
      matches(query, character.name, character.jobId, character.characterId, character.imported?.id, character.imported?.label),
  );
}

export function countGroups(characters: readonly FactoryCharacter[]): Record<CharacterFilter, number> {
  const counts: Record<CharacterFilter, number> = { todo: 0, all: characters.length, new: 0, update: 0, current: 0 };
  for (const character of characters) counts[characterGroup(character)] += 1;
  counts.todo = counts.new + counts.update;
  return counts;
}

export type ItemFilter = {
  query: string;
  kind: CatalogKind | 'all';
  status: CatalogStatus | 'all';
  source: AdminCatalogItem['source'] | 'all';
};
export type ItemSort = 'order' | 'label' | 'updated' | 'usage';

export const ITEM_SORTS: readonly { value: ItemSort; label: string }[] = [
  { value: 'order', label: '보이는 순서' },
  { value: 'label', label: '이름' },
  { value: 'updated', label: '최근 바뀐 것' },
  { value: 'usage', label: '많이 쓰는 것' },
];

export function filterItems(items: readonly AdminCatalogItem[], filter: ItemFilter): AdminCatalogItem[] {
  return items.filter(
    (item) =>
      (filter.kind === 'all' || item.kind === filter.kind) &&
      (filter.status === 'all' || item.status === filter.status) &&
      (filter.source === 'all' || item.source === filter.source) &&
      matches(filter.query, item.id, item.label, item.emoji, item.characterId, item.sourceRef),
  );
}

const byOrder = (a: AdminCatalogItem, b: AdminCatalogItem) =>
  a.kind.localeCompare(b.kind) || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);

/** A sorted copy; ties fall back to the order the picker shows. */
export function sortItems(items: readonly AdminCatalogItem[], sort: ItemSort): AdminCatalogItem[] {
  const compare: Record<ItemSort, (a: AdminCatalogItem, b: AdminCatalogItem) => number> = {
    order: byOrder,
    label: (a, b) => a.label.localeCompare(b.label, 'ko') || byOrder(a, b),
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt) || byOrder(a, b),
    usage: (a, b) => b.usage - a.usage || byOrder(a, b),
  };
  return [...items].sort(compare[sort]);
}

/** What retiring or unpublishing `items` does to members, for a confirmation; null when nobody wears them. */
export function retireWarning(items: readonly Pick<AdminCatalogItem, 'label' | 'usage' | 'kind'>[]): string | null {
  const worn = items.filter((item) => item.kind === 'minime' && item.usage > 0);
  if (!worn.length) return null;
  const homes = worn.reduce((sum, item) => sum + item.usage, 0);
  const names = worn.map((item) => item.label).join(', ');
  return `${names}: 섬 ${homes.toLocaleString('ko-KR')}곳이 이 미니미를 쓰고 있어요. 목록에서 빠지면 그 섬들은 기본 미니미로 보여요. 계속할까요?`;
}
