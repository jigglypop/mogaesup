import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The dock over the real 보물찾기 and a game for two or three (to see 시작 wait for players).
vi.mock('../registry', async () => {
  const { treasure } = await import('../treasure');
  const pair = {
    kind: 'pair', label: '둘이서', minPlayers: 2, maxPlayers: 3, layout: () => ({ goal: 3 }),
    Panel: () => <p>둘이서 진행</p>, Result: () => <p>둘이서 결과</p>,
    attention: (view: { ask?: number } | null) => (view?.ask ? `ask-${view.ask}` : null),
  };
  const GAMES = [treasure, pair];
  return { GAMES, gameOf: (kind: string | null | undefined) => GAMES.find((game) => game.kind === kind) ?? null };
});

import { createVillage } from '../../minihome/village';
import { mount } from '../../__tests__/mount';
import { GameDock } from '../GameDock';
import type { GameSession } from '../protocol';
import { GameContext, type GameRoomValue } from '../room';
import type { GameClient, GameState } from '../useGameSession';

const NOW = 9_000_000;
const me = { id: 'me', name: '나', peer: 'peer-me' };
const friend = { id: 'friend', name: '친구', peer: 'peer-friend' };

function fakeClient(initial: Partial<GameState>) {
  let state: GameState = { session: null, connected: true, error: null, ...initial };
  const listeners = new Set<() => void>();
  const client = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: vi.fn(() => true),
    join: vi.fn(() => true),
    leave: vi.fn(() => true),
    start: vi.fn((_layout: unknown) => true),
    act: vi.fn(() => true),
    close: vi.fn(() => true),
    onEvent: vi.fn(() => () => {}),
    serverNow: () => NOW,
    teleport: vi.fn(() => false),
    setTeleporter: vi.fn(() => () => {}),
    clearError: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } satisfies GameClient;
  const set = (changes: Partial<GameState>) =>
    act(() => {
      state = { ...state, ...changes };
      for (const listener of [...listeners]) listener();
    });
  return { client, set };
}

const session = (changes: Partial<GameSession> = {}): GameSession => ({
  kind: 'pair', phase: 'lobby', host: me.id, players: [me], you: me.id, game: null, result: null, seq: 1, now: NOW, ...changes,
});

const mounted: { unmount: () => Promise<void> }[] = [];

async function dock(initial: Partial<GameState>, live = true) {
  const { client, set } = fakeClient(initial);
  const room: GameRoomValue = { client, live, building: createVillage, playerRef: { current: null } };
  const view = await mount(
    <GameContext.Provider value={room}>
      <GameDock />
    </GameContext.Provider>,
  );
  mounted.push(view);
  const button = (name: string) =>
    [...view.container.querySelectorAll('button')].find((item) => item.textContent?.trim().startsWith(name) || item.getAttribute('aria-label') === name);
  const press = (name: string) => act(() => button(name)!.click());
  const toggle = () => view.container.querySelector<HTMLButtonElement>('.mg-game-toggle')!;
  const panel = () => view.container.querySelector<HTMLElement>('.mg-game');
  return { view, client, set, button, press, toggle, panel };
}

describe('섬의 게임 패널', () => {
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
  });

  it('실시간 방에 없으면 아무것도 두지 않는다', async () => {
    const { view } = await dock({}, false);
    expect(view.container.innerHTML).toBe('');
  });

  it('열린 게임이 없으면 게임 이름만 늘어놓고 고르면 연다', async () => {
    const { toggle, panel, press, client } = await dock({});
    expect(toggle().getAttribute('aria-label')).toBe('게임');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(panel()).toBeNull();
    await act(() => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(panel());
    const names = [...panel()!.querySelectorAll('.mg-game-list button')].map((item) => item.textContent);
    expect(names).toEqual(['보물찾기', '둘이서']);
    await press('보물찾기');
    expect(client.open).toHaveBeenCalledWith('treasure');
  });

  it('연결 중이면 그 상태만 보이고, Esc로 접으면 버튼으로 돌아간다', async () => {
    const { toggle, panel } = await dock({ connected: false });
    await act(() => toggle().click());
    expect(panel()!.querySelector('[role="status"]')!.textContent).toBe('연결 중…');
    expect(panel()!.querySelectorAll('.mg-game-list, .mg-game-actions')).toHaveLength(0);
    await act(() => panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it('대기실의 방장은 사람이 모일 때까지 시작할 수 없고, 모이면 게임의 배치로 시작한다', async () => {
    const { toggle, panel, button, press, client, set } = await dock({ session: session() });
    expect(toggle().getAttribute('aria-label')).toBe('게임 1명');
    expect(toggle().querySelector('.mg-count')!.textContent).toBe('1');
    await act(() => toggle().click());
    expect(panel()!.querySelector('h2')!.textContent).toBe('둘이서');
    const players = [...panel()!.querySelectorAll('.mg-game-players li')].map((item) => item.textContent);
    expect(players).toEqual(['나방장']);
    expect(button('참가')).toBeUndefined();
    expect(button('시작')!.textContent).toBe('시작 1/2');
    expect(button('시작')!.disabled).toBe(true);
    await press('닫기');
    expect(client.close).toHaveBeenCalled();
    set({ session: session({ players: [me, friend] }) });
    expect(button('시작')!.textContent).toBe('시작 2명');
    expect(button('시작')!.disabled).toBe(false);
    await press('시작');
    expect(client.start).toHaveBeenCalledWith({ goal: 3 });
    await press('나가기');
    expect(client.leave).toHaveBeenCalled();
  });

  it('대기실을 보는 사람은 참가만 할 수 있고, 자리가 차면 참가할 수 없다', async () => {
    const watching = session({ host: friend.id, players: [friend] });
    const { toggle, button, press, client, set } = await dock({ session: watching });
    await act(() => toggle().click());
    expect(button('시작')).toBeUndefined();
    expect(button('닫기')).toBeUndefined();
    await press('참가');
    expect(client.join).toHaveBeenCalled();
    const others = [1, 2, 3].map((index) => ({ id: `p${index}`, name: `사람${index}`, peer: null }));
    set({ session: { ...watching, players: others } });
    expect(button('참가')!.disabled).toBe(true);
  });

  it('보물찾기 방장의 시작은 섬의 빈 자리를 보낸다', async () => {
    const { toggle, press, client } = await dock({ session: session({ kind: 'treasure' }) });
    await act(() => toggle().click());
    await press('시작');
    const layout = client.start.mock.calls[0]![0] as { spots: [number, number, number][] };
    expect(layout.spots.length).toBeGreaterThanOrEqual(12);
    expect(layout.spots.length).toBeLessThanOrEqual(200);
  });

  it('게임이 시작되면 참가한 사람의 패널이 열려 남은 시간과 점수를 보여 준다', async () => {
    const { toggle, panel, button, set } = await dock({ session: session({ kind: 'treasure', players: [me, friend] }) });
    expect(panel()).toBeNull();
    const view = {
      gems: [{ id: 1, position: [0, 0, 0], value: 3 }],
      scores: [{ id: me.id, name: '나', score: 1 }, { id: friend.id, name: '친구', score: 4 }],
      endsAt: NOW + 95_000,
    };
    set({ session: session({ kind: 'treasure', phase: 'playing', players: [me, friend], game: view }) });
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(panel()!.querySelector('[role="timer"]')!.textContent).toBe('1:35');
    const rows = [...panel()!.querySelectorAll('.mg-game-scores li')];
    expect(rows.map((row) => row.textContent)).toEqual(['친구4', '나1']);
    expect(rows[1]!.getAttribute('aria-current')).toBe('true');
    expect(button('나가기')).toBeDefined();
    expect(button('닫기')).toBeDefined();
    // A refusal is said in the panel.
    set({ error: { code: 'bad_action', message: '할 수 없는 행동이에요.' } });
    expect(panel()!.querySelector('[role="alert"]')!.textContent).toBe('할 수 없는 행동이에요.');
  });

  it('접어 둔 패널은 게임이 답을 기다릴 때마다 한 번씩 다시 열린다', async () => {
    const { toggle, panel, set } = await dock({ session: session({ phase: 'playing', players: [me, friend], game: {} }) });
    expect(panel()).not.toBeNull();
    await act(() => toggle().click());
    expect(panel()).toBeNull();
    set({ session: session({ phase: 'playing', players: [me, friend], game: { ask: 1 } }) });
    expect(panel()).not.toBeNull();
    // Folded again while the same question waits, it stays folded; the next question brings it up.
    await act(() => toggle().click());
    set({ session: session({ phase: 'playing', players: [me, friend], game: { ask: 1 }, seq: 2 }) });
    expect(panel()).toBeNull();
    set({ session: session({ phase: 'playing', players: [me, friend], game: { ask: 2 }, seq: 3 }) });
    expect(panel()).not.toBeNull();
  });

  it('끝나면 결과를 보여 주고, 방장은 다시 하거나 닫고 다른 사람은 나간다', async () => {
    const ended = session({
      kind: 'treasure', phase: 'ended', players: [me, friend],
      game: { gems: [], scores: [], endsAt: NOW },
      result: { ranking: [
        { id: friend.id, name: '친구', score: 4, rank: 1 },
        { id: me.id, name: '나', score: 4, rank: 1 },
      ] },
    });
    const host = await dock({ session: ended });
    await act(() => host.toggle().click());
    const rows = [...host.panel()!.querySelectorAll('.mg-game-scores li')].map((row) => row.textContent);
    expect(rows).toEqual(['1위친구4점', '1위나4점']);
    expect(host.button('나가기')).toBeUndefined();
    await host.press('다시 하기');
    expect(host.client.open).toHaveBeenCalledWith('treasure');
    await host.press('닫기');
    expect(host.client.close).toHaveBeenCalled();
    await host.view.unmount();
    mounted.splice(mounted.indexOf(host.view), 1);

    const guest = await dock({ session: { ...ended, you: friend.id } });
    await act(() => guest.toggle().click());
    expect(guest.button('다시 하기')).toBeUndefined();
    expect(guest.button('닫기')).toBeUndefined();
    await guest.press('나가기');
    expect(guest.client.leave).toHaveBeenCalled();
  });
});
