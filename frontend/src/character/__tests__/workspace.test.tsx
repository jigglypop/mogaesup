import { act } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FactoryUsage, PermissionName, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { FactoryUsageContext } from '../../studio/usage';
import { factoryApi } from '../factory/api';
import { studioApi } from '../studio/api';
import { Workspace } from '../studio/Workspace';

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: auth.user, status: 'signedIn' }) }));
vi.mock('../studio/AssetGallery', () => ({ AssetGallery: () => null }));
vi.mock('../studio/GlbAssetLibrary', () => ({ GlbAssetLibrary: () => null }));
const user = (...permissions: PermissionName[]): User => ({ id: 'u1', username: 'mogae', displayName: '모개', role: 'user', permissions });

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
