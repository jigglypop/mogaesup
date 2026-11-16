import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionName, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import Generations from '../studio/Generations';
import { generationsApi, type Generation } from '../studio/generations-api';

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: auth.user, status: 'signedIn' }) }));
// The WebGPU viewer is not what is tested: it loads any model but the broken one.
vi.mock('../viewer', () => ({
  ModelViewer: class {
    load = vi.fn(async (url: string) => {
      if (url.includes('broken')) throw new Error('모델 파일을 불러올 수 없어요');
      return [];
    });
    dispose = vi.fn();
  },
}));

const PENDING = 'gaesup.studio.generation.prop.v1';
const user = (...permissions: PermissionName[]): User => ({ id: 'u1', username: 'mogae', displayName: '모개', role: 'user', permissions });
const generation = (id: string, name: string, model?: string): Generation => ({
  id, request_key: `${id}-key`, kind: 'prop', category: 'furniture', name, prompt: `${name} 프롬프트`, size: 512,
  status: 'complete', stage: 'complete', can_resume: false, created_at: '2026-10-01T00:00:00Z', provider: 'meshy',
  artifacts: model ? [{ name: 'model.glb', url: model, sha256: 'a'.repeat(64) }] : [],
});
const settle = () =>
  act(async () => {
    for (let round = 0; round < 3; round++) await new Promise((done) => setTimeout(done, 0));
  });
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text))!;

describe('기물 화면', () => {
  beforeEach(() => {
    auth.user = user('operator', 'paid_operator');
    vi.spyOn(generationsApi, 'list').mockResolvedValue({
      items: [generation('broken', '부서진 의자', '/models/broken.glb'), generation('desk', '책상', '/models/desk.glb'), generation('lamp', '등불')],
      capabilities: { ready: true },
      defaults: {},
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('3D를 불러오지 못한 기물에서 다른 기물로 옮기면 그 오류가 남지 않는다', async () => {
    const { container, unmount } = await mount(<Generations />);
    await settle();
    expect(container.querySelector('.generation-result [role=alert]')?.textContent).toBe('모델 파일을 불러올 수 없어요');

    await act(async () => button(container, '책상').click());
    await settle();
    expect(container.querySelector('.generation-result h2')?.textContent).toBe('책상');
    expect(container.querySelector('[role=alert]')).toBeNull();

    // Back on the broken one, its model fails again and says so beside it.
    await act(async () => button(container, '부서진 의자').click());
    await settle();
    expect(container.querySelector('.generation-result [role=alert]')?.textContent).toBe('모델 파일을 불러올 수 없어요');

    // A prop with no model shows none, and no warning about another's.
    await act(async () => button(container, '등불').click());
    await settle();
    expect(container.querySelector('.generation-result h2')?.textContent).toBe('등불');
    expect(container.querySelector('[role=alert]')).toBeNull();
    await unmount();
  });

  it('다른 탭이 이미 복구해 지운 요청도 이 화면의 복구 버튼은 같은 요청 키로만 보낸다', async () => {
    const input = { kind: 'prop', category: 'furniture', name: '의자', prompt: '나무 의자', size: 512 };
    localStorage.setItem(PENDING, JSON.stringify({ key: 'lost-key', input }));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ...generation('chair', '의자', '/models/chair.glb'), request_key: 'lost-key' }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { container, unmount } = await mount(<Generations />);
    await settle();
    // Another tab got the answer and forgot the saved request after this screen last looked.
    localStorage.removeItem(PENDING);
    await act(async () => button(container, '같은 요청 복구').click());
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Idempotency-Key')).toBe('lost-key');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(input);
    expect(localStorage.getItem(PENDING)).toBeNull();
    await unmount();
  });
});
