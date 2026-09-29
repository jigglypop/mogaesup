import { describe, expect, it } from 'vitest';

import type { AdminCatalogItem, CatalogImport, FactoryCharacter } from '../../../api/types';
import {
  activeImportFor,
  countGroups,
  faceText,
  filterCharacters,
  filterItems,
  finishedSince,
  formatBytes,
  outcomeText,
  parseSortOrder,
  reportCounts,
  retireWarning,
  sortItems,
  stepStates,
  suggestedId,
  textProblem,
  textureText,
} from '../catalogView';

const item = (id: string, changes: Partial<AdminCatalogItem> = {}): AdminCatalogItem => ({
  id,
  kind: 'minime',
  label: id,
  emoji: '🙂',
  modelUrl: `/models/${id}.glb`,
  thumbnailUrl: null,
  clips: ['idle', 'walk'],
  source: 'factory',
  sourceRef: null,
  status: 'draft',
  sortOrder: 100,
  characterId: null,
  versionId: null,
  versionCount: 0,
  usage: 0,
  updatedAt: '2026-09-01T00:00:00Z',
  ...changes,
});

const character = (jobId: string, imported: FactoryCharacter['imported'] = null): FactoryCharacter => ({
  jobId,
  characterId: `c_${jobId}`,
  name: `${jobId} 캐릭터`,
  version: 'v1',
  stage: 'complete',
  createdAt: null,
  thumbnailUrl: '',
  face: null,
  faceKnown: true,
  sourceRef: `${jobId}/v1`,
  modelUrl: '',
  imported,
  otherItems: [],
});

const copy = (id: string, current: boolean): NonNullable<FactoryCharacter['imported']> => ({
  id,
  label: `${id} 이름`,
  emoji: '🙂',
  status: 'published',
  thumbnailUrl: null,
  sourceRef: null,
  current,
  freshness: current ? 'current' : 'newFace',
});

const job = (id: string, changes: Partial<CatalogImport> = {}): CatalogImport => ({
  id,
  itemId: `item-${id}`,
  kind: 'minime',
  label: '이름',
  emoji: '🙂',
  factoryJobId: `job-${id}`,
  characterId: null,
  replaces: false,
  status: 'running',
  step: 'download',
  progress: 30,
  detail: null,
  errorCode: null,
  errorMessage: null,
  report: null,
  versionId: null,
  requestedBy: 'mogae',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  finishedAt: null,
  ...changes,
});

describe('가져오기 단계', () => {
  it('지금 단계 앞은 끝났고, 실패한 단계를 가리킨다', () => {
    const states = (changes: Partial<CatalogImport>) => stepStates(job('a', changes)).map((entry) => entry.state);
    expect(states({ status: 'queued', step: 'queued' })).toEqual(['active', ...Array(7).fill('waiting')]);
    expect(states({ status: 'running', step: 'verify' })).toEqual(['done', 'done', 'done', 'active', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(states({ status: 'failed', step: 'source' })).toEqual(['done', 'failed', ...Array(6).fill('waiting')]);
    expect(states({ status: 'done', step: 'done' })).toEqual(Array(8).fill('done'));
  });

  it('돌던 가져오기가 끝난 것만 골라낸다', () => {
    const before = [job('a'), job('b', { status: 'queued', step: 'queued' }), job('c', { status: 'done', step: 'done' })];
    const after = [job('a', { status: 'done', step: 'done' }), job('b'), job('c', { status: 'done', step: 'done' }), job('d', { status: 'failed' })];
    expect(finishedSince(before, after).map((entry) => entry.id)).toEqual(['a']);
  });

  it('항목·작업·캐릭터로 돌고 있는 가져오기를 찾는다', () => {
    const imports = [job('a', { characterId: 'c1' }), job('b', { status: 'done' })];
    expect(activeImportFor(imports, { itemId: 'item-a' })?.id).toBe('a');
    expect(activeImportFor(imports, { jobId: 'job-a' })?.id).toBe('a');
    expect(activeImportFor(imports, { jobId: 'other', characterId: 'c1' })?.id).toBe('a');
    expect(activeImportFor(imports, { itemId: 'item-b' })).toBeUndefined();
    expect(activeImportFor(imports, { characterId: null })).toBeUndefined();
  });

  it('결과를 한국어로 알리고 보고서의 오류·경고를 센다', () => {
    expect(outcomeText(job('a', { status: 'failed', errorMessage: 'GLB 파일이 아닙니다.' }))).toBe('GLB 파일이 아닙니다.');
    expect(outcomeText(job('a'))).toBe('모델 받기 중');
    const report = { checks: [{ code: 'skin', level: 'error' as const, message: '' }, { code: 'height', level: 'warning' as const, message: '' }], outcome: 'unchanged' as const };
    expect(outcomeText(job('a', { status: 'done', step: 'done', report }))).toBe('바뀐 것이 없어 지금 버전을 그대로 둬요');
    expect(reportCounts(report)).toEqual({ errors: 1, warnings: 1 });
    expect(reportCounts(null)).toEqual({ errors: 0, warnings: 0 });
  });
});

describe('스튜디오 캐릭터 목록', () => {
  const list = [character('fresh'), character('behind', copy('hero', false)), character('same', copy('twin', true))];

  it('새 캐릭터·새 버전·최신으로 나누고 이름·ID·항목으로 찾는다', () => {
    expect(countGroups(list)).toEqual({ todo: 2, all: 3, new: 1, update: 1, current: 1 });
    expect(filterCharacters(list, 'todo', '').map((entry) => entry.jobId)).toEqual(['fresh', 'behind']);
    expect(filterCharacters(list, 'update', '').map((entry) => entry.jobId)).toEqual(['behind']);
    expect(filterCharacters(list, 'all', 'HERO').map((entry) => entry.jobId)).toEqual(['behind']);
    expect(filterCharacters(list, 'all', ' c_same ').map((entry) => entry.jobId)).toEqual(['same']);
    expect(filterCharacters(list, 'new', 'behind')).toEqual([]);
  });

  it('표정과 텍스처를 짧게 적는다', () => {
    expect(faceText({ face: 'a1b2c3d4e5f6', faceKnown: true })).toBe('표정 a1b2c3d4');
    expect(faceText({ face: null, faceKnown: false })).toBe('표정 확인 못 함');
    expect(textureText({ image: 0, mime: 'image/jpeg', width: 1024, height: 512, bytes: 2048 })).toBe('1024×512 · JPEG · 2 KB');
    expect(textureText({ image: 1, mime: null, width: null, height: null, bytes: null })).toBe('크기 모름 · —');
  });

  it('작업 ID에서 카탈로그 ID를 만든다', () => {
    expect(suggestedId({ jobId: 'A1b2.C3d4-E5f6g7h8' })).toBe('char-a1b2-c3d4-e5');
    expect(suggestedId({ jobId: 'abcdefghijk.xyz' })).toBe('char-abcdefghijk');
    expect(suggestedId({ jobId: '...' })).toBe('char-new');
  });
});

describe('카탈로그 표', () => {
  const items = [
    item('b', { label: '나비', sortOrder: 20, usage: 3, updatedAt: '2026-09-02T00:00:00Z', status: 'published' }),
    item('a', { label: '가재', sortOrder: 20, usage: 0, updatedAt: '2026-09-03T00:00:00Z' }),
    item('man', { label: '청년', sortOrder: 10, usage: 3, source: 'builtin', status: 'published' }),
    item('lamp', { kind: 'furniture', label: '등', sortOrder: 1 }),
  ];

  it('종류·상태·출처와 검색어로 거른다', () => {
    const all = { query: '', kind: 'all', status: 'all', source: 'all' } as const;
    expect(filterItems(items, { ...all, kind: 'furniture' }).map((entry) => entry.id)).toEqual(['lamp']);
    expect(filterItems(items, { ...all, status: 'published', source: 'factory' }).map((entry) => entry.id)).toEqual(['b']);
    expect(filterItems(items, { ...all, query: '청' }).map((entry) => entry.id)).toEqual(['man']);
  });

  it('순서·이름·최근·사용 수로 정렬하고 같으면 보이는 순서를 따른다', () => {
    const ids = (sort: Parameters<typeof sortItems>[1]) => sortItems(items, sort).map((entry) => entry.id);
    expect(ids('order')).toEqual(['lamp', 'man', 'a', 'b']);
    expect(ids('label')).toEqual(['a', 'b', 'lamp', 'man']);
    expect(ids('updated')).toEqual(['a', 'b', 'lamp', 'man']);
    expect(ids('usage')).toEqual(['man', 'b', 'lamp', 'a']);
    expect(items.map((entry) => entry.id)).toEqual(['b', 'a', 'man', 'lamp']);
  });

  it('쓰는 섬이 있는 미니미를 내리기 전에 알려 준다', () => {
    expect(retireWarning([item('a')])).toBeNull();
    expect(retireWarning([item('lamp', { kind: 'furniture', usage: 9 })])).toBeNull();
    expect(retireWarning([item('a', { label: '가재', usage: 2 }), item('b', { label: '나비', usage: 1 })])).toContain('가재, 나비: 섬 3곳');
  });

  it('입력값을 서버와 같은 규칙으로 확인한다', () => {
    expect(textProblem('  ', 30)).toBe('비워 둘 수 없어요');
    expect(textProblem('👩‍🏫', 16)).toBeNull();
    expect(textProblem('가'.repeat(31), 30)).toBe('30자까지 쓸 수 있어요');
    expect(parseSortOrder(' 15 ')).toBe(15);
    expect(parseSortOrder('-3')).toBe(-3);
    expect(parseSortOrder('1.5')).toBeNull();
    expect(parseSortOrder('99999999999')).toBeNull();
  });

  it('크기를 서버 메시지와 같은 단위로 적는다', () => {
    expect(formatBytes(900)).toBe('1 KB');
    expect(formatBytes(30 * 1024 * 1024)).toBe('30.0 MB');
    expect(formatBytes(null)).toBe('—');
  });
});
