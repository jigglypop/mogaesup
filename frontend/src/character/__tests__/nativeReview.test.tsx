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
  beforeEach(() => sessionStorage.clear()); afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
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
    expect(sessionStorage.length).toBe(0); await unmount();
  });
});
