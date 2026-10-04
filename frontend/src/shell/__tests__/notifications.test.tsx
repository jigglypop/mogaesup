import { act } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { TopActions } from '../Shell';

const { requests } = vi.hoisted(() => ({ requests: vi.fn() }));
vi.mock('../../api/endpoints', () => ({ socialApi: { requests, accept: vi.fn(), dismiss: vi.fn() } }));
const user: User = { id: 'u1', username: 'mogae', displayName: '모개', role: 'user' };
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user, logout: vi.fn() }) }));

/** jsdom's tab is always shown; this one hides and shows like a real one. */
const tab = (hidden: boolean) =>
  act(async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  });

describe('알림 확인', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requests.mockResolvedValue({ received: [], sent: [] });
  });
  afterEach(() => {
    delete (document as { hidden?: boolean }).hidden;
    requests.mockReset();
    vi.useRealTimers();
  });

  it('숨은 탭에서는 1분마다 묻지 않고, 다시 보일 때 놓친 확인을 한 번 한다', async () => {
    const { unmount } = await mount(
      <MemoryRouter>
        <TopActions search={false} />
      </MemoryRouter>,
    );
    expect(requests).toHaveBeenCalledTimes(1);

    await tab(true);
    await act(async () => vi.advanceTimersByTimeAsync(180_000));
    expect(requests).toHaveBeenCalledTimes(1);
    await tab(false);
    expect(requests).toHaveBeenCalledTimes(2);

    // Hidden and shown again before the next check was due: nothing was missed.
    await tab(true);
    await tab(false);
    expect(requests).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(requests).toHaveBeenCalledTimes(3);
    await unmount();
  });
});
