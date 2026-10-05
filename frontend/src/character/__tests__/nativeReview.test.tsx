import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type } from '../../__tests__/mount';
import { ApiError } from '../api';
import { factoryApi, type NativePartsState } from '../factory/api';
import { NativeReview } from '../factory/NativeReview';

vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { role: 'admin' } }) }));
const sha = 'a'.repeat(64), state: NativePartsState = { version: 'v1', status: 'review_required', assembly_sha256: sha, parts: [], artifacts: [] };
const click = (element: Element) => act(async () => (element as HTMLElement).click());
describe('native 시각 승인', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); }); afterEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });
  it('외형과 동작 확인 후 정확한 조립 SHA로 승인하고 응답 손실은 같은 키로 복구한다', async () => {
    const send = vi.spyOn(factoryApi, 'reviewNative').mockRejectedValueOnce(new ApiError('connection', '연결 끊김', 0)).mockResolvedValue({ ...state, review: { status: 'approved' } });
    const change = vi.fn(), { container, unmount } = await mount(<NativeReview jobId="job" state={state} onChange={change} />);
    await type(container.querySelector('textarea')!, '외형과 걷기 확인 완료');
    let approve = [...container.querySelectorAll('button')].find(button => button.textContent === '시각 승인')!;
    expect(approve.disabled).toBe(true);
    for (const checkbox of container.querySelectorAll('input[type=checkbox]')) await click(checkbox);
    approve = [...container.querySelectorAll('button')].find(button => button.textContent === '시각 승인')!;
    await click(approve);
    expect(send.mock.calls[0]![2]).toEqual({ expected_assembly_sha256: sha, decision: 'approved', appearance_checked: true, motion_checked: true, notes: '외형과 걷기 확인 완료' });
    await click([...container.querySelectorAll('button')].find(button => button.textContent === '검수 기록 복구')!);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]); expect(change).toHaveBeenCalledWith(expect.objectContaining({ review: { status: 'approved' } }));
    expect(localStorage.length).toBe(0); await unmount();
  });

  it('기록한 뒤에는 같은 폼으로 다시 보내지 않고, 다시 검수를 골라야 새로 기록한다', async () => {
    const recorded = { ...state, review: { status: 'approved' as const, decision: 'approved' as const, assembly_sha256: sha, reviewer_name: '운영자' } };
    const send = vi.spyOn(factoryApi, 'reviewNative').mockResolvedValue(recorded);
    let current = state;
    const change = vi.fn((value: NativePartsState) => { current = value; });
    const { container, rerender, unmount } = await mount(<NativeReview jobId="job" state={current} onChange={change} />);
    await type(container.querySelector('textarea')!, '외형과 걷기 확인 완료');
    for (const checkbox of container.querySelectorAll('input[type=checkbox]')) await click(checkbox);
    await click([...container.querySelectorAll('button')].find(button => button.textContent === '시각 승인')!);
    await rerender(<NativeReview jobId="job" state={current} onChange={change} />);
    expect(container.querySelector('[role=status]')?.textContent).toBe('시각 검수 · 시각 승인 · 운영자');
    expect([...container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['다시 검수']);
    await click([...container.querySelectorAll('button')].find(button => button.textContent === '다시 검수')!);
    expect(container.querySelector('textarea')!.value).toBe('');
    expect([...container.querySelectorAll('button')].find(button => button.textContent === '시각 승인')!.disabled).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    await unmount();
  });

  it('저장된 검수 요청을 읽지 못하면 막지 않고 지울 수 있게 한다', async () => {
    localStorage.setItem('gaesup.native-review:job:v1', '{broken');
    const send = vi.spyOn(factoryApi, 'reviewNative');
    const { container, unmount } = await mount(<NativeReview jobId="job" state={state} onChange={vi.fn()} />);
    expect(container.querySelector('[role=alert]')?.textContent).toBe('저장된 검수 요청 읽기 실패');
    expect(container.querySelector('fieldset')!.disabled).toBe(true);
    await click([...container.querySelectorAll('button')].find(button => button.textContent === '저장된 검수 요청 지우기')!);
    expect(localStorage.getItem('gaesup.native-review:job:v1')).toBeNull();
    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(container.querySelector('fieldset')!.disabled).toBe(false);
    expect(send).not.toHaveBeenCalled();
    await unmount();
  });

  it('예전처럼 탭 저장소에 남은 요청도 이어서 복구한다', async () => {
    const saved = { key: 'old-key', input: { expected_assembly_sha256: sha, decision: 'changes_requested', appearance_checked: false, motion_checked: false, notes: '소매 확인 필요' } };
    sessionStorage.setItem('gaesup.native-review:job:v1', JSON.stringify(saved));
    const send = vi.spyOn(factoryApi, 'reviewNative').mockResolvedValue(state);
    const { container, unmount } = await mount(<NativeReview jobId="job" state={state} onChange={vi.fn()} />);
    expect(container.querySelector('[role=status]')?.textContent).toBe('응답 확인 안 됨');
    await click([...container.querySelectorAll('button')].find(button => button.textContent === '검수 기록 복구')!);
    expect(send).toHaveBeenCalledWith('job', 'v1', saved.input, 'old-key');
    expect(sessionStorage.length + localStorage.length).toBe(0);
    await unmount();
  });
});
