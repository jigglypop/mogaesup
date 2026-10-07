import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SavedRequestGone } from '../api';
import { factoryApi } from '../factory/api';
import { studioApi } from '../studio/api';
import { baseBodiesApi } from '../studio/base-bodies-api';
import { expressionGenerationApi } from '../studio/expression-generation-api';
import { glbAssetsApi } from '../studio/glb-assets-api';
import { glbBodiesApi } from '../studio/glb-bodies-api';
import { generationsApi } from '../studio/generations-api';
import { hairBatchesApi } from '../studio/hair-batches-api';
import { meshyDefaultsFor } from '../studio/meshy-options';

const hash = (letter: string) => letter.repeat(64);
const KEY = 'saved-request-key';
// Each paid or record-making request a screen can recover: where it is saved, what it holds, and how the screen sends it
// again. The answer carries the key, as the server's records do.
const recoveries: [string, string, unknown, () => Promise<unknown>][] = [
  ['단일 파츠', 'gaesup.studio.single-part.v1',
    { base_job_id: 'base', base_version: 'v1', slot: 'top', hair_length: 'source', bottom_kind: 'source' }, () => studioApi.recoverSinglePart(KEY)],
  ['동물 추가', 'gaesup.studio.animal-create.v1', { name: '강아지', species: 'dog', reference: hash('a') }, () => studioApi.recoverAnimalCreate(KEY)],
  ['동물 다시 만들기', 'gaesup.studio.animal-regenerate.dog.v1', { views: ['front'], note: '', model: true, rig: true },
    () => studioApi.recoverAnimalRegeneration('dog', KEY)],
  ['기물 생성', 'gaesup.studio.generation.prop.v1', { kind: 'prop', category: 'furniture', name: '의자', prompt: 'chair', size: 512 },
    () => generationsApi.recover('prop', KEY)],
  ['원화 생성', 'gaesup.studio.generation.illustration.v1', { kind: 'illustration', category: 'character', name: '원화', prompt: 'art', size: 1024 },
    () => generationsApi.recover('illustration', KEY)],
  ['헤어 배치', 'gaesup.hair-batch.pending.v1', { base_job_id: 'base', base_version: 'v1', concurrency: 4, meshy_options: meshyDefaultsFor('hair'),
    items: [{ name: '단발', views: { front: hash('a'), side: hash('b'), back: hash('c') } }] }, () => hairBatchesApi.recover(KEY)],
  ['이미지로 기본 몸', 'gaesup.base-body:male', { name: '기본 남성형', body_type: 'male', views: { front: hash('a'), side: hash('b'), back: hash('c') } },
    () => baseBodiesApi.recover('male', KEY)],
  ['GLB 기본 몸', 'gaesup.base-body-glb-pending:female', { name: '기본 여성형', body_type: 'female', model_asset: hash('d'), import_mode: 'rig',
    generate_motions: true, prepare_expression_uv: false }, () => glbBodiesApi.recover('female', KEY)],
  ['GLB 등록', 'gaesup.glb-assets.register.v1', { name: '모자', slot: 'hat', model_asset: hash('e') }, () => glbAssetsApi.recoverCreate(KEY)],
  ['GLB 후처리', 'gaesup.glb-assets.prepare.v1:asset', { action: 'rig', body_type: 'male' }, () => glbAssetsApi.recoverPrepare('asset', KEY)],
  ['표정 텍스처', 'gaesup.studio.expression-generation.job.v1.v1', { name: 'smile', prompt: 'smile' }, () => expressionGenerationApi.recover('job', 'v1', KEY)],
  ['표정 기본 5종', 'gaesup.studio.expression-generation-batch.job.v1.v1', { reference_assets: ['asset'] },
    () => expressionGenerationApi.recoverBatch('job', 'v1', KEY)],
  ['피팅', 'gaesup.part-refit:job', { source_version: 'v1', slot: 'top' }, () => factoryApi.resumeRefit('job', KEY)],
];

describe('저장된 요청 복구', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: 'answer', request_key: KEY, status: 'accepted', artifacts: [], parts: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it.each(recoveries)('%s: 저장된 키와 입력 그대로 다시 보낸다', async (_name, storage, input, recover) => {
    localStorage.setItem(storage, JSON.stringify({ key: KEY, input }));
    await recover();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(KEY);
    expect(JSON.parse(String(init?.body))).toEqual(input);
    expect(localStorage.getItem(storage)).toBeNull();
  });

  it.each(recoveries)('%s: 다른 탭이 이미 처리해 지운 요청은 새 키로 보내지 않는다', async (_name, storage, _input, recover) => {
    expect(localStorage.getItem(storage)).toBeNull();
    await expect(recover()).rejects.toBeInstanceOf(SavedRequestGone);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(storage)).toBeNull();
  });
});
