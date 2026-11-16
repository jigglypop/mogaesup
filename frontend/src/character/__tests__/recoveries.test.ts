import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
type Recovery = [name: string, storage: string, input: unknown, send: () => Promise<unknown>];
/** A recovery button: it sends the saved request it shows, `input` under `KEY`, the way its screen does. */
const recovery = <T,>(name: string, storage: string, input: T, send: (input: T, key: string) => Promise<unknown>): Recovery =>
  [name, storage, input, () => send(input, KEY)];
// Each paid or record-making request a screen can recover: where it is saved, what it holds, and how the screen sends it
// again. The answer carries the key, as the server's records do.
const recoveries: Recovery[] = [
  recovery<Parameters<typeof studioApi.singlePart>[0]>('단일 파츠', 'gaesup.studio.single-part.v1',
    { base_job_id: 'base', base_version: 'v1', slot: 'top', hair_length: 'source', bottom_kind: 'source' }, studioApi.singlePart),
  recovery<Parameters<typeof studioApi.createAnimal>[0]>('동물 추가', 'gaesup.studio.animal-create.v1',
    { name: '강아지', species: 'dog', reference: hash('a') }, studioApi.createAnimal),
  recovery<Parameters<typeof studioApi.regenerateAnimal>[1]>('동물 다시 만들기', 'gaesup.studio.animal-regenerate.dog.v1',
    { views: ['front'], note: '', model: true, rig: true }, (input, key) => studioApi.regenerateAnimal('dog', input, key)),
  recovery<Parameters<typeof generationsApi.create>[0]>('기물 생성', 'gaesup.studio.generation.prop.v1',
    { kind: 'prop', category: 'furniture', name: '의자', prompt: 'chair', size: 512 }, generationsApi.create),
  recovery<Parameters<typeof generationsApi.create>[0]>('원화 생성', 'gaesup.studio.generation.illustration.v1',
    { kind: 'illustration', category: 'character', name: '원화', prompt: 'art', size: 1024 }, generationsApi.create),
  recovery<Parameters<typeof hairBatchesApi.create>[0]>('헤어 배치', 'gaesup.hair-batch.pending.v1',
    { base_job_id: 'base', base_version: 'v1', concurrency: 4, meshy_options: meshyDefaultsFor('hair'),
      items: [{ name: '단발', views: { front: hash('a'), side: hash('b'), back: hash('c') } }] }, hairBatchesApi.create),
  recovery<Parameters<typeof baseBodiesApi.create>[0]>('이미지로 기본 몸', 'gaesup.base-body:male',
    { name: '기본 남성형', body_type: 'male', views: { front: hash('a'), side: hash('b'), back: hash('c') } }, baseBodiesApi.create),
  recovery<Parameters<typeof glbBodiesApi.create>[0]>('GLB 기본 몸', 'gaesup.base-body-glb-pending:female',
    { name: '기본 여성형', body_type: 'female', model_asset: hash('d'), import_mode: 'rig', generate_motions: true, prepare_expression_uv: false },
    glbBodiesApi.create),
  recovery<Parameters<typeof glbAssetsApi.create>[0]>('GLB 등록', 'gaesup.glb-assets.register.v1',
    { name: '모자', slot: 'hat', model_asset: hash('e') }, glbAssetsApi.create),
  recovery<Parameters<typeof glbAssetsApi.prepare>[1]>('GLB 후처리', 'gaesup.glb-assets.prepare.v1:asset',
    { action: 'rig', body_type: 'male' }, (input, key) => glbAssetsApi.prepare('asset', input, key)),
  recovery<Parameters<typeof expressionGenerationApi.create>[2]>('표정 텍스처', 'gaesup.studio.expression-generation.job.v1.v1',
    { name: 'smile', prompt: 'smile' }, (input, key) => expressionGenerationApi.create('job', 'v1', input, key)),
  recovery<Parameters<typeof expressionGenerationApi.createBatch>[2]>('표정 기본 5종', 'gaesup.studio.expression-generation-batch.job.v1.v1',
    { reference_assets: ['asset'] }, (input, key) => expressionGenerationApi.createBatch('job', 'v1', input, key)),
  recovery('피팅', 'gaesup.part-refit:job', { source_version: 'v1', slot: 'top' }, (input, key) => factoryApi.resumeRefit('job', { key, input })),
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

  const sent = () => {
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    return { key: new Headers(init?.headers).get('Idempotency-Key'), input: JSON.parse(String(init?.body)) as unknown };
  };

  it.each(recoveries)('%s: 저장된 키와 입력 그대로 다시 보낸다', async (_name, storage, input, recover) => {
    localStorage.setItem(storage, JSON.stringify({ key: KEY, input }));
    await recover();
    expect(sent()).toEqual({ key: KEY, input });
    expect(localStorage.getItem(storage)).toBeNull();
  });

  // The server answers a key it has seen with what that key made, so nothing is made twice.
  it.each(recoveries)('%s: 다른 탭이 이미 처리해 지운 요청도 새 키가 아니라 그 키로 보낸다', async (_name, storage, input, recover) => {
    expect(localStorage.getItem(storage)).toBeNull();
    await recover();
    expect(sent()).toEqual({ key: KEY, input });
    expect(localStorage.getItem(storage)).toBeNull();
  });
});
