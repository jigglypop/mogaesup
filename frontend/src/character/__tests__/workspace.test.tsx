import { act } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FactoryUsage, PermissionName, User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { FactoryUsageContext } from '../../studio/usage';
import { ApiError } from '../api';
import { factoryApi, type FactoryJob } from '../factory/api';
import { studioApi } from '../studio/api';
import { Workspace } from '../studio/Workspace';

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: auth.user, status: 'signedIn' }) }));
vi.mock('../studio/AssetGallery', () => ({ AssetGallery: () => null }));
vi.mock('../studio/GlbAssetLibrary', () => ({ GlbAssetLibrary: () => null }));
vi.mock('../studio/AssetModelPreview', () => ({ AssetModelPreview: () => null }));
// The screens that keep lists of their own; only what the workspace reads around them is tested here.
vi.mock('../studio/Textures', () => ({ default: () => null }));
vi.mock('../studio/Generations', () => ({ default: () => null }));
vi.mock('../studio/Emoticons', () => ({ default: () => null }));
vi.mock('../studio/Animals', () => ({ default: () => null }));
vi.mock('../studio/Prompts', () => ({ default: () => null }));
const user = (...permissions: PermissionName[]): User => ({ id: 'u1', username: 'mogae', displayName: '모개', role: 'user', permissions });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

describe('에셋 라이브러리의 만들기 버튼', () => {
  let previous: string;
  beforeEach(() => {
    previous = `${location.pathname}${location.search}`;
    vi.spyOn(factoryApi, 'list').mockResolvedValue({ jobs: [] });
    vi.spyOn(factoryApi, 'bodyProfile').mockResolvedValue({ revision: '1', body: null });
    vi.spyOn(studioApi, 'catalog').mockResolvedValue({ revision: '1', items: {}, parts: {} });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState(null, '', previous);
  });
  const actions = async (usage: FactoryUsage | null) => {
    // The studio page hands the workspace its screen in the query before it mounts (see StudioPage).
    history.replaceState(null, '', '/admin/studio/library?tab=admin');
    const { container, unmount } = await mount(<MemoryRouter><FactoryUsageContext.Provider value={usage}><Workspace /></FactoryUsageContext.Provider></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    const labels = [...container.querySelectorAll('.admin-heading-actions button')].map((item) => item.textContent);
    await unmount();
    return labels;
  };

  it('유료 작업자가 아닌 운영자에게는 유료 화면으로 보내는 버튼이 없다', async () => {
    auth.user = user('operator');
    expect(await actions(null)).toEqual(['GLB 등록']);
  });

  it('유료 작업자는 기본 몸·헤어 만들기 화면으로 갈 수 있다', async () => {
    auth.user = user('operator', 'paid_operator');
    expect(await actions(null)).toEqual(['기본 몸 추가', '헤어 생성', 'GLB 등록']);
    expect(await actions({ connected: true, access: 'paid', paidThisMonth: 0, paidMonthly: 5 })).toEqual(['기본 몸 추가', '헤어 생성', 'GLB 등록']);
  });

  it('서버가 유료 작업을 막아 두었으면 유료 작업자에게도 보이지 않는다', async () => {
    auth.user = user('operator', 'paid_operator');
    expect(await actions({ connected: true, access: 'write', paidThisMonth: 0, paidMonthly: 5 })).toEqual(['GLB 등록']);
  });
});

describe('에셋 상세의 이름·보관 저장', () => {
  const body: FactoryJob = { id: 'body', character_id: 'mogae', character_name: '모개', source_sha256: '', status: 'complete',
    created_at: '2026-01-01T00:00:00Z', progress: { stage: 'complete', message: '' }, artifacts: [], production_mode: 'character_parts' };
  const nameField = () => document.querySelector<HTMLInputElement>('.admin-detail-dialog input[name="name"]')!;
  const archivedField = () => document.querySelector<HTMLInputElement>('.admin-detail-dialog input[name="archived"]')!;
  const detailAlert = () => document.querySelector('.admin-detail-dialog [role="alert"]')?.textContent;
  const submit = async () => {
    await act(async () => nameField().form!.querySelector('button')!.click());
    await settle();
  };
  let previous: string, view: Awaited<ReturnType<typeof mount>> | undefined;
  beforeEach(() => {
    previous = `${location.pathname}${location.search}`;
    auth.user = user('operator');
    // jsdom does not open dialogs.
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    vi.spyOn(factoryApi, 'list').mockResolvedValue({ jobs: [body] });
    vi.spyOn(factoryApi, 'bodyProfile').mockResolvedValue({ revision: '1', body: null });
    vi.spyOn(factoryApi, 'nativeParts').mockResolvedValue({ status: 'missing', parts: [], artifacts: [] });
    history.replaceState(null, '', '/admin/studio/library?tab=admin&asset=body');
  });
  afterEach(async () => {
    await view?.unmount();
    view = undefined;
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    history.replaceState(null, '', previous);
  });
  const open = async () => {
    view = await mount(<MemoryRouter><Workspace /></MemoryRouter>);
    await settle();
  };

  it('다른 운영자가 먼저 저장해 거절되면 관리 목록을 다시 읽고, 입력한 이름을 새 목록 기준으로 다시 저장한다', async () => {
    const catalog = vi.spyOn(studioApi, 'catalog').mockResolvedValue({ revision: '1', items: {}, parts: {} });
    const save = vi.spyOn(studioApi, 'saveMetadata')
      .mockRejectedValueOnce(new ApiError('revision_conflict', '관리 목록이 변경되었습니다. 다시 불러오세요.', 409))
      .mockImplementationOnce(async (id, name, archived) => ({ revision: '3', items: { [id]: { name, archived } }, parts: {} }));
    await open();
    await type(nameField(), '새 이름');
    // Another operator renamed a different asset in the meantime.
    catalog.mockResolvedValue({ revision: '2', items: { other: { name: '다른 에셋' } }, parts: {} });
    await submit();
    expect(save).toHaveBeenLastCalledWith('body', '새 이름', false, '1');
    expect(detailAlert()).toBe('관리 목록이 변경되었습니다. 다시 불러오세요.');
    expect(nameField().value).toBe('새 이름');
    await submit();
    expect(save).toHaveBeenLastCalledWith('body', '새 이름', false, '2');
    expect(detailAlert()).toBeUndefined();
    expect(nameField().value).toBe('새 이름');
  });

  it('이름을 고치는 동안 관리 목록을 다시 읽어도 입력한 이름은 남고, 손대지 않은 보관 표시는 새 목록을 따른다', async () => {
    const catalog = vi.spyOn(studioApi, 'catalog').mockResolvedValue({ revision: '1', items: {}, parts: {} });
    const save = vi.spyOn(studioApi, 'saveMetadata').mockImplementation(async (id, name, archived) => ({ revision: '3', items: { [id]: { name, archived } }, parts: {} }));
    await open();
    await type(nameField(), '새 이름');
    // Another operator archived this asset; the screen shown again reads every list, as its polls do.
    catalog.mockResolvedValue({ revision: '2', items: { body: { archived: true } }, parts: {} });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(nameField().value).toBe('새 이름');
    expect(archivedField().checked).toBe(true);
    await submit();
    expect(save).toHaveBeenLastCalledWith('body', '새 이름', true, '2');
  });
});

describe('작업 목록·관리 목록·기본 몸을 쓰지 않는 화면', () => {
  let previous: string;
  beforeEach(() => {
    previous = `${location.pathname}${location.search}`;
    auth.user = user('operator');
    // A studio that has just woken up has not listed its jobs yet.
    vi.spyOn(factoryApi, 'list').mockRejectedValue(new ApiError('listing_pending', '저장된 생산 목록을 불러오고 있습니다. 잠시 후 다시 동기화합니다.', 503));
    vi.spyOn(factoryApi, 'bodyProfile').mockResolvedValue({ revision: '1', body: null });
    vi.spyOn(studioApi, 'catalog').mockResolvedValue({ revision: '1', items: {}, parts: {} });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState(null, '', previous);
  });
  const alertOn = async (tab: string) => {
    history.replaceState(null, '', `/admin/studio?tab=${tab}`);
    const { container, unmount } = await mount(<MemoryRouter><Workspace /></MemoryRouter>);
    await settle();
    const alert = container.querySelector('[role="alert"]')?.textContent;
    await unmount();
    return alert;
  };

  it('읽지 않고 그 오류도 띄우지 않는다. 에셋 라이브러리는 그대로 읽고 띄운다', async () => {
    for (const tab of ['textures', 'props', 'emoticons', 'animals', 'prompts']) expect(await alertOn(tab)).toBeUndefined();
    expect(factoryApi.list).not.toHaveBeenCalled();
    expect(studioApi.catalog).not.toHaveBeenCalled();
    expect(factoryApi.bodyProfile).not.toHaveBeenCalled();
    expect(await alertOn('admin')).toBe('저장된 생산 목록을 불러오고 있습니다. 잠시 후 다시 동기화합니다.');
    expect(factoryApi.list).toHaveBeenCalledOnce();
    expect(studioApi.catalog).toHaveBeenCalledOnce();
    expect(factoryApi.bodyProfile).toHaveBeenCalledOnce();
  });
});
