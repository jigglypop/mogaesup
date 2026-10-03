import { act } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { EditHelp, SaveBanners } from '../edit/EditChrome';
import type { IslandSaver, SaveProblem, SaverState } from '../edit/save';
import type { EditSession } from '../edit/session';

vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));

const saverWith = (problem: SaveProblem) => {
  const state: SaverState = { phase: 'ready', saving: false, dirty: true, conflict: false, problem, lastSavedAt: null, bytes: null };
  return { getState: () => state, subscribe: () => () => {}, save: vi.fn(async () => false) } as unknown as IslandSaver & { save: ReturnType<typeof vi.fn> };
};
const banner = (problem: SaveProblem) => {
  const saver = saverWith(problem);
  return {
    saver,
    view: mount(
      <MemoryRouter initialEntries={['/@mogae/edit']}>
        <SaveBanners saver={saver} editing onReloaded={() => {}} />
      </MemoryRouter>,
    ),
  };
};
const buttons = (container: HTMLElement) => [...container.querySelectorAll('button')].map((button) => button.textContent?.trim());

describe('저장 문제 알림', () => {
  it('로그인이 풀렸으면 이 화면으로 돌아오는 다시 로그인 링크를 주고, 그 링크로 나가도 편집을 버리지 않는다', async () => {
    const { view } = banner({ kind: 'session', message: '로그인이 풀려 저장하지 못했어요. 다시 로그인하면 이어서 저장해요.' });
    const { container, unmount } = await view;
    const link = container.querySelector('a')!;
    expect(link.textContent).toBe('다시 로그인');
    expect(link.getAttribute('href')).toBe('/?next=%2F%40mogae%2Fedit');
    expect(link.hasAttribute('data-keep-edits')).toBe(true);
    expect(buttons(container)).toEqual([]);
    await unmount();
  });

  it('같은 섬을 다시 보내 봐야 거절될 실패에는 다시 시도를 두지 않는다', async () => {
    for (const kind of ['invalid', 'tooLarge', 'auth'] as const) {
      const { view } = banner({ kind, message: '문제' });
      const { container, unmount } = await view;
      expect(container.querySelector('[role=alert]')?.textContent).toContain('문제');
      expect(buttons(container)).toEqual([]);
      await unmount();
    }
  });

  it('연결이나 서버 탓이면 다시 시도할 수 있다', async () => {
    const { saver, view } = banner({ kind: 'network', message: '인터넷 연결이 끊겼어요.' });
    const { container, unmount } = await view;
    expect(buttons(container)).toEqual(['다시 시도']);
    await act(async () => container.querySelector('button')!.click());
    expect(saver.save).toHaveBeenCalledTimes(1);
    await unmount();
  });
});

describe('단축키 도움말', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false })));
  afterEach(() => vi.unstubAllGlobals());

  it('열린 동안 키보드를 안에 두고, 닫히면 연 곳으로 돌려보낸다', async () => {
    let help = true;
    const listeners = new Set<() => void>();
    const session = {
      getState: () => ({ help }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setHelp: (next: boolean) => {
        help = next;
        for (const listener of listeners) listener();
      },
    } as unknown as EditSession;
    const opener = document.body.appendChild(document.createElement('button'));
    opener.focus();
    const { container, unmount } = await mount(<EditHelp session={session} />);
    const close = container.querySelector<HTMLButtonElement>('[aria-label="닫기"]')!;
    expect(document.activeElement).toBe(close);

    const tab = (shiftKey = false) =>
      act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
      });
    await tab();
    expect(document.activeElement).toBe(close);
    await tab(true);
    expect(document.activeElement).toBe(close);
    // Focus that slipped outside comes back in on the next Tab.
    opener.focus();
    await tab();
    expect(container.contains(document.activeElement)).toBe(true);

    await act(async () => session.setHelp(false));
    expect(container.querySelector('[role=dialog]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
    await unmount();
  });
});
