import { act, type ReactNode } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FactoryUsage, PermissionName, User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { FactoryUsageContext, PAID_WORK_OFF } from '../../studio/usage';
import { factoryApi } from '../factory/api';
import Animals from '../studio/Animals';
import { studioApi, type Animal } from '../studio/api';
import BaseBodies from '../studio/BaseBodies';
import Emoticons from '../studio/Emoticons';
import { ExpressionGenerationPanel } from '../studio/ExpressionGeneration';
import { expressionGenerationApi, type ExpressionGeneration } from '../studio/expression-generation-api';
import Generations from '../studio/Generations';
import { generationsApi, type Generation } from '../studio/generations-api';
import { GlbAssetLibrary } from '../studio/GlbAssetLibrary';
import { glbAssetsApi } from '../studio/glb-assets-api';
import { glbBodiesApi, type BodyGlbAsset } from '../studio/glb-bodies-api';
import { expressionNames } from '../texture-expressions';

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: auth.user, status: 'signedIn' }) }));
// What the paid buttons allow and say is tested here, not the previews (WebGPU, visibility) or the panels beside them.
vi.mock('../studio/AssetModelPreview', () => ({ AssetModelPreview: () => null }));
vi.mock('../studio/AssetDetailDialog', () => ({ AssetDetailDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../studio/WardrobeBodies', () => ({ WardrobeBodies: () => null }));

type GenerationList = Awaited<ReturnType<typeof generationsApi.list>>;
const user = (...permissions: PermissionName[]): User => ({ id: 'u1', username: 'mogae', displayName: '모개', role: 'user', permissions });
const open: FactoryUsage = { connected: true, access: 'paid', paidThisMonth: 0, paidMonthly: 5 };
const closed: FactoryUsage = { connected: true, access: 'write', paidThisMonth: 0, paidMonthly: 5 };
const hash = 'a'.repeat(64);

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const render = async (usage: FactoryUsage, element: ReactNode) => {
  const mounted = await mount(<FactoryUsageContext.Provider value={usage}>{element}</FactoryUsageContext.Provider>);
  await settle();
  return mounted;
};
const labels = (container: HTMLElement) => [...container.querySelectorAll('button')].map(item => item.textContent);
const button = (container: HTMLElement, label: string) => {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === label);
  if (!found) throw new Error(`no ${label} button among ${labels(container).join(' / ')}`);
  return found;
};
const field = (container: HTMLElement, label: string) => {
  const found = [...container.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)?.querySelector('input');
  if (!found) throw new Error(`no ${label} field`);
  return found;
};
const choose = (container: HTMLElement, file: File) => act(async () => {
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
// jsdom has no implicit submission; this is what a browser does when Enter is pressed in a form's text field.
const pressEnter = (input: HTMLInputElement) => act(async () => {
  const fallback = [...input.form!.elements].find((item): item is HTMLButtonElement => item instanceof HTMLButtonElement && item.type === 'submit');
  if (fallback) { if (!fallback.disabled) fallback.click(); }
  else input.form!.requestSubmit();
});

const pausedAnimal: Animal = {
  id: 'dog-1', name: '바둑이', species: 'dog', created_at: '2026-10-01T00:00:00Z',
  stages: { views: null, model: null, rig: null, walk: null, standard: null },
  production: { id: 'job-1', request_key: 'animal-key-1', status: 'paused', step: null, steps: ['views', 'model', 'rig'], done: [],
    views: ['front', 'left', 'back', 'right'], note: '' },
  artifacts: [{ name: 'reference.png', url: '/api/studio/animals/dog-1/reference.png', sha256: hash }],
};
const generation = (change: Partial<Generation>): Generation => ({
  id: 'prop-1', request_key: 'prop-key-1', kind: 'prop', category: 'furniture', name: '의자', prompt: '나무 의자', size: 512,
  status: 'paused', stage: 'image', can_resume: true, created_at: '2026-10-01T00:00:00Z', artifacts: [], provider: 'tripo', ...change,
});
const illustration = (change: Partial<Generation> = {}) => generation({ id: 'art-1', kind: 'illustration', category: 'character', size: 1024, provider: null, ...change });
const props = (capabilities: GenerationList['capabilities'], items: Generation[] = []): GenerationList => ({ items, capabilities, defaults: { furniture: '가구' } });
const glbAsset: BodyGlbAsset = { id: hash, bytes: 1048576, rigged: false, bone_count: 0, triangles: 1000, animations: [] };

beforeEach(() => {
  auth.user = user('operator', 'paid_operator');
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('서버가 유료 작업을 막아 둔 동안', () => {
  it('동물을 추가하거나 다시 만들거나 이어서 실행할 수 없고, 그 상태를 보인다', async () => {
    vi.spyOn(studioApi, 'animals').mockResolvedValue({ items: [pausedAnimal] });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reference');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    for (const [usage, off] of [[open, false], [closed, true]] as const) {
      const { container, unmount } = await render(usage, <Animals />);
      await choose(container, new File(['png'], '바둑이.png', { type: 'image/png' }));
      await act(async () => button(container, '크게 보기').click());
      expect(button(container, '동물 추가').disabled).toBe(off);
      expect(button(container, '처음부터 다시 만들기 · 유료 이미지 4장 + Meshy 30크레딧').disabled).toBe(off);
      expect(button(container, '이어서 실행 · 유료 최대 이미지 4장 + Meshy 30크레딧').disabled).toBe(off);
      expect(container.textContent!.includes(PAID_WORK_OFF)).toBe(off);
      await unmount();
    }
  });

  it('기물 생성과 계속 진행을 막고, 그 상태를 보인다', async () => {
    localStorage.setItem('gaesup.studio.generation-draft.prop.v1', JSON.stringify({ category: 'furniture', name: '의자', prompt: '나무 의자', promptEdited: true, size: 512 }));
    vi.spyOn(generationsApi, 'list').mockResolvedValue(props({ ready: true, providers: ['meshy', 'tripo'], default_provider: 'tripo' }, [generation({})]));
    for (const [usage, off] of [[open, false], [closed, true]] as const) {
      const { container, unmount } = await render(usage, <Generations />);
      expect(button(container, '유료 생성 · 이미지 1장 + Tripo 1회').disabled).toBe(off);
      expect(button(container, '계속 진행 · 유료 최대 이미지 1장 + Tripo 1회').disabled).toBe(off);
      expect(container.textContent!.includes(PAID_WORK_OFF)).toBe(off);
      await unmount();
    }
  });

  it('2D 원화 생성과 계속 진행을 막고, 그 상태를 보인다', async () => {
    localStorage.setItem('gaesup.studio.illustration-draft.v1', JSON.stringify({ name: '모개', prompt: '웃는 모개', edited: true, useReference: false }));
    vi.spyOn(generationsApi, 'list').mockResolvedValue({ items: [illustration()], capabilities: { ready: true }, defaults: { character: '기본 원화' } });
    vi.spyOn(generationsApi, 'illustrationSelection').mockResolvedValue({ selected: null, revision: '1' });
    for (const [usage, off] of [[open, false], [closed, true]] as const) {
      const { container, unmount } = await render(usage, <Emoticons />);
      expect(button(container, '원화 생성 · 이미지 1회').disabled).toBe(off);
      expect(button(container, '계속 진행 · 유료 최대 이미지 1회').disabled).toBe(off);
      expect(container.textContent!.includes(PAID_WORK_OFF)).toBe(off);
      await unmount();
    }
  });

  it('기본 몸을 이미지로 만들거나 GLB로 등록할 수 없고, 그 상태를 보인다', async () => {
    localStorage.setItem('gaesup.base-body-draft:male', JSON.stringify({ name: '기본 남성형', views: { front: hash, side: hash, back: hash } }));
    localStorage.setItem('gaesup.base-body-glb-draft:male', JSON.stringify({ name: '기본 남성형', asset: glbAsset, filename: 'body.glb', import_mode: 'register', generate_motions: true, prepare_expression_uv: false }));
    vi.spyOn(factoryApi, 'rigTransferSources').mockResolvedValue({ items: [] });
    vi.spyOn(glbBodiesApi, 'info').mockResolvedValue(glbAsset);
    for (const [usage, off] of [[open, false], [closed, true]] as const) {
      const { container, unmount } = await render(usage, <BaseBodies jobs={[]} onJob={() => {}} refreshJobs={async () => {}} />);
      expect(button(container, '바로 등록').disabled).toBe(off);
      expect(container.textContent!.includes(PAID_WORK_OFF)).toBe(off);
      await act(async () => button(container, '이미지로 생성').click());
      expect(button(container, '기본 몸 3D 생성').disabled).toBe(off);
      expect(container.textContent!.includes(PAID_WORK_OFF)).toBe(off);
      await unmount();
    }
  });
});

describe('2D 원화 이름에서 Enter', () => {
  it('유료 원화 생성을 보내지 않고, 생성 버튼을 눌러야 보낸다', async () => {
    vi.spyOn(generationsApi, 'list').mockResolvedValue({ items: [], capabilities: { ready: true }, defaults: { character: '기본 원화' } });
    vi.spyOn(generationsApi, 'illustrationSelection').mockResolvedValue({ selected: null, revision: '1' });
    const create = vi.spyOn(generationsApi, 'create').mockResolvedValue(illustration({ status: 'accepted', can_resume: false }));
    const { container, unmount } = await render(open, <Emoticons />);
    const name = field(container, '원화 이름');
    await type(name, '모개');
    await pressEnter(name);
    await settle();
    expect(create).not.toHaveBeenCalled();
    await act(async () => button(container, '원화 생성 · 이미지 1회').click());
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    await unmount();
  });
});

describe('기물 생성 버튼', () => {
  it('새 기물의 3D 요청이 갈 공급자를 보인다', async () => {
    const cases: [GenerationList['capabilities'], string][] = [
      [{ ready: true, providers: ['meshy', 'tripo'], default_provider: 'tripo' }, '유료 생성 · 이미지 1장 + Tripo 1회'],
      [{ ready: true, providers: ['meshy'], default_provider: 'meshy' }, '유료 생성 · 이미지 1장 + Meshy 1회'],
      // A studio that does not say which provider: no provider is named.
      [{ ready: true }, '유료 생성 · 이미지 1장 + 3D 1회'],
    ];
    for (const [capabilities, label] of cases) {
      vi.spyOn(generationsApi, 'list').mockResolvedValue(props(capabilities));
      const { container, unmount } = await render(open, <Generations />);
      expect(labels(container)).toContain(label);
      await unmount();
    }
  });
});

describe('유료 작업을 이어 가는 버튼', () => {
  it('기물은 남은 단계와 그 기물의 3D 공급자를 보인다', async () => {
    for (const [stage, label] of [['image', '계속 진행 · 유료 최대 이미지 1장 + Tripo 1회'], ['model', '계속 진행 · 유료 최대 Tripo 1회']] as const) {
      // The studio's default is Meshy; the paused prop was accepted for Tripo.
      vi.spyOn(generationsApi, 'list').mockResolvedValue(props({ ready: true, providers: ['meshy', 'tripo'], default_provider: 'meshy' }, [generation({ stage })]));
      const { container, unmount } = await render(open, <Generations />);
      expect(labels(container)).toContain(label);
      await unmount();
    }
  });

  it('동물은 아직 끝나지 않은 단계의 유료 요청을 보인다', async () => {
    const cases: [Partial<NonNullable<Animal['production']>>, string][] = [
      [{ done: [] }, '이어서 실행 · 유료 최대 이미지 4장 + Meshy 30크레딧'],
      [{ done: ['views'] }, '이어서 실행 · 유료 최대 Meshy 30크레딧'],
      [{ steps: ['rig'], views: [] }, '이어서 실행 · 표준 골격'],
    ];
    for (const [change, label] of cases) {
      vi.spyOn(studioApi, 'animals').mockResolvedValue({ items: [{ ...pausedAnimal, production: { ...pausedAnimal.production!, ...change } }] });
      const { container, unmount } = await render(open, <Animals />);
      await act(async () => button(container, '크게 보기').click());
      expect(labels(container)).toContain(label);
      await unmount();
    }
  });

  it('표정 텍스처는 남은 이미지 수를 보인다', async () => {
    const item = { id: 'expression-1', request_key: 'expression-key-1', job_id: 'job-1', body_version: 'v1', body_sha256: hash, name: 'smile', prompt: '웃음',
      source: { kind: 'reference', sha256: hash }, status: 'paused', stage: 'image', error: null, can_resume: true, created_at: '2026-10-01T00:00:00Z', artifacts: [] } satisfies ExpressionGeneration;
    vi.spyOn(expressionGenerationApi, 'list').mockResolvedValue({
      items: [item], capabilities: { ready: true, reason: null },
      defaults: Object.fromEntries(Object.keys(expressionNames).map(name => [name, name])) as Record<keyof typeof expressionNames, string>,
      reference: { revision: '1', assets: [] },
      batches: [{ id: 'batch-1', request_key: 'batch-key-1', status: 'paused', created_at: '2026-10-01T00:00:00Z', error: null, can_resume: true, items: [
        { name: 'neutral', generation_id: 'g1', status: 'complete', error: null },
        { name: 'smile', generation_id: 'g2', status: 'paused', error: null },
        { name: 'cry', generation_id: null, status: 'pending', error: null },
      ] }],
    });
    const { container, unmount } = await render(open, <ExpressionGenerationPanel job="job-1" version="v1" ready onApply={async () => {}} />);
    expect(labels(container)).toEqual(expect.arrayContaining(['계속 진행 · 유료 최대 이미지 2회', '계속 진행 · 유료 최대 이미지 1회']));
    await unmount();
  });

  it('GLB를 기준몸에 맞추는 버튼은 유료 작업임을 보인다', async () => {
    vi.spyOn(glbAssetsApi, 'list').mockResolvedValue({ items: [{ id: 'glb-1', name: '앞머리', slot: 'hair', model_asset: hash, created_at: '2026-10-01T00:00:00Z',
      source: { url: '/api/studio/glb-assets/glb-1/source.glb', sha256: hash }, info: glbAsset }] });
    const { container, unmount } = await render(open, <GlbAssetLibrary bases={[]} onJob={() => {}} />);
    await act(async () => container.querySelector<HTMLButtonElement>('.glb-asset-list button')!.click());
    expect(labels(container)).toContain('몸에 맞추기 · 기존 골격 연결 · 유료 1회');
    await unmount();
  });
});
