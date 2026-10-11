import { act } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import type { FactoryJob } from '../factory/api';
import { GlbBodyForm } from '../studio/GlbBodyForm';
import { glbBodiesApi } from '../studio/glb-bodies-api';

// A paid operator, who may register a body GLB (paid studio work).
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { permissions: ['operator', 'paid_operator'] }, status: 'signedIn' }) }));

const settle = () => act(async () => { for (let round = 0; round < 3; round++) await new Promise((done) => setTimeout(done, 0)); });

describe('기본 몸 GLB', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('파일만 올라갔을 때는 등록 완료라고 하지 않고, 등록은 접수한 뒤에 알린다', async () => {
    const asset = { id: 'a'.repeat(64), bytes: 2048, rigged: false, bone_count: 0, triangles: 1200, animations: [] };
    vi.spyOn(glbBodiesApi, 'upload').mockResolvedValue(asset);
    vi.spyOn(glbBodiesApi, 'info').mockResolvedValue(asset);
    const create = vi.spyOn(glbBodiesApi, 'create').mockResolvedValue({ id: 'body-job' } as FactoryJob);
    const { container, unmount } = await mount(<GlbBodyForm bodyType="male" onJob={() => {}} refreshJobs={async () => {}} onBusy={() => {}} />);
    const input = container.querySelector<HTMLInputElement>('.glb-upload input')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array([1])], 'body.glb')] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => container.querySelector<HTMLButtonElement>('.glb-upload-selection button')!.click());
    await settle();
    expect(container.textContent).not.toContain('등록 완료');
    expect(container.querySelector('.glb-upload-status')?.textContent).toBe('업로드 완료');
    expect(create).not.toHaveBeenCalled();

    await act(async () => [...container.querySelectorAll('button')].find((item) => item.textContent === '바로 등록')!.click());
    await settle();
    expect(create).toHaveBeenCalledOnce();
    expect(container.querySelector('.base-body-glb > [role=status]')?.textContent).toBe('GLB 등록 작업을 접수했습니다.');
    await unmount();
  });
});
