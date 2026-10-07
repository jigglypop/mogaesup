import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeChannel } from '../../__tests__/broadcast';
import { openSessionChannel, SESSION_CHANNEL } from '../otherTabs';

afterEach(() => {
  vi.unstubAllGlobals();
  FakeChannel.open.clear();
  localStorage.clear();
});

describe('탭 사이의 로그인 알림', () => {
  it('BroadcastChannel로 다른 탭에만 알리고, 닫으면 더 듣지 않는다', () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const mine = vi.fn();
    const theirs = vi.fn();
    const here = openSessionChannel(mine);
    const there = openSessionChannel(theirs);
    here.announce('u1');
    expect(theirs).toHaveBeenCalledTimes(1);
    expect(mine).not.toHaveBeenCalled();
    there.close();
    here.announce(null);
    expect(theirs).toHaveBeenCalledTimes(1);
    here.close();
    // A closed channel says nothing, and does not throw.
    expect(() => here.announce('u1')).not.toThrow();
  });

  it('세션을 새로 열었다는 알림(비밀번호 바꾸기)은 로그인 알림과 구별해 전한다', () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const theirs = vi.fn();
    const here = openSessionChannel(vi.fn());
    const there = openSessionChannel(theirs);
    here.announce('u1', true);
    here.announce('u2');
    expect(theirs.mock.calls).toEqual([[{ userId: 'u1', renewed: true }], [{ userId: 'u2' }]]);
    here.close();
    there.close();
  });

  it('localStorage로 전할 때도 새로 연 세션을 구별하고, 읽을 수 없는 값도 바뀐 것으로 듣는다', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const changed = vi.fn();
    const channel = openSessionChannel(changed);
    channel.announce('u1', true);
    expect(JSON.parse(localStorage.getItem(SESSION_CHANNEL)!)).toMatchObject({ userId: 'u1', renewed: true });
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_CHANNEL, newValue: localStorage.getItem(SESSION_CHANNEL) }));
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_CHANNEL, newValue: 'not json' }));
    expect(changed.mock.calls).toEqual([[{ userId: 'u1', renewed: true }], [{ userId: null }]]);
    channel.close();
  });

  it('BroadcastChannel이 없으면 localStorage에 쓰고, 다른 탭의 storage 이벤트로 듣는다', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const changed = vi.fn();
    const channel = openSessionChannel(changed);
    channel.announce('u1');
    expect(JSON.parse(localStorage.getItem(SESSION_CHANNEL)!)).toMatchObject({ userId: 'u1' });
    const first = localStorage.getItem(SESSION_CHANNEL);
    channel.announce('u1');
    // The same member again is still a change other tabs hear.
    expect(localStorage.getItem(SESSION_CHANNEL)).not.toBe(first);

    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_CHANNEL, newValue: '{"userId":null}' }));
    expect(changed).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'mogaesup.theme', newValue: 'dark' }));
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_CHANNEL, newValue: null }));
    expect(changed).toHaveBeenCalledTimes(1);
    channel.close();
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_CHANNEL, newValue: '{"userId":"u2"}' }));
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
