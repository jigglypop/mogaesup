import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { createVillage } from '../../minihome/village';
import type { GameProps, GameResultProps } from '../game';
import { GameDock } from '../GameDock';
import type { GameSession } from '../protocol';
import { GameContext, type GameRoomValue } from '../room';
import type { SoccerResult, SoccerView } from '../soccer';
import { findField } from '../soccer/field';
import { useKickKey } from '../soccer/kick';
import { SoccerPanel, SoccerScore } from '../soccer/Panel';
import { openSpots } from '../spots';
import type { GameClient, GameState } from '../useGameSession';

const NOW = 9_000_000;
const me = { id: 'me', name: '나', peer: 'peer-me' };
const friend = { id: 'friend', name: '친구', peer: 'peer-friend' };

const view = (changes: Partial<SoccerView> = {}): SoccerView => ({
  field: { center: [0, 0, 0], axis: 'x', halfLength: 20, halfWidth: 12, mouth: 6 },
  ball: { position: [0, 0, 0], velocity: [0, 0, 0], at: NOW },
  score: { a: 2, b: 1 },
  teams: { a: [me.id], b: [friend.id] },
  team: 'a',
  phase: 'play',
  endsAt: NOW + 95_000,
  kickoff: null,
  ...changes,
});

function props(game: SoccerView, changes: Partial<GameProps<SoccerView>> = {}): GameProps<SoccerView> {
  const session: GameSession<SoccerView> = {
    kind: 'soccer', phase: 'playing', host: me.id, players: [me, friend], you: me.id, game, result: null, seq: 1, now: NOW,
  };
  return {
    session, view: game, me, act: vi.fn(() => true), onEvent: () => () => {}, serverNow: () => NOW, teleport: vi.fn(() => true),
    ...changes,
  };
}

/** This page's clock, which the kick's cooldown reads. */
let clockNow = 0;
const mounted: { unmount: () => Promise<void> }[] = [];

async function render(element: ReactNode) {
  const view = await mount(element);
  mounted.push(view);
  const rows = (label: string) => [...view.container.querySelectorAll(`[aria-label="${label}"] li`)];
  const kick = () => view.container.querySelector<HTMLButtonElement>('.mg-soccer-kick');
  return { ...view, rows, kick };
}

describe('축구 패널', () => {
  beforeEach(() => {
    clockNow = 50_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clockNow);
  });
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
    vi.restoreAllMocks();
  });

  it('경기 중에는 남은 시간과 두 팀의 점수, 내 팀을 보여 주고 차기를 보낸다', async () => {
    const game = props(view());
    const { container, rows, kick } = await render(<SoccerPanel {...game} />);
    expect(container.querySelector('[role="timer"]')!.textContent).toBe('1:35');
    expect(container.querySelector('.mg-badge')!.textContent).toBe('내 팀');
    const score = rows('점수');
    expect(score.map((row) => row.textContent)).toEqual(['A팀내 팀2', 'B팀1']);
    expect(score.map((row) => row.getAttribute('aria-current'))).toEqual(['true', null]);
    expect(score.map((row) => row.querySelector('.mg-soccer-swatch')!.getAttribute('data-team'))).toEqual(['a', 'b']);
    // 차기 sends the kick; pressed again within the server's 0.4 s it waits rather than be refused.
    expect(kick()!.disabled).toBe(false);
    expect(kick()!.getAttribute('aria-keyshortcuts')).toBe('F');
    await act(() => kick()!.click());
    expect(game.act).toHaveBeenCalledWith({ kick: true });
    clockNow += 399;
    await act(() => kick()!.click());
    expect(game.act).toHaveBeenCalledTimes(1);
    clockNow += 1;
    await act(() => kick()!.click());
    expect(game.act).toHaveBeenCalledTimes(2);
  });

  it('킥오프 동안에는 시계가 멈춰 있고 차기를 누를 수 없다', async () => {
    const kickoff = view({ phase: 'kickoff', kickoff: { n: 2, until: NOW + 2_000, spot: [-6, 0, 0] }, endsAt: NOW + 2_000 + 61_000 });
    const { container, kick } = await render(<SoccerPanel {...props(kickoff)} />);
    expect(container.querySelector('[role="timer"]')!.textContent).toBe('1:01');
    expect([...container.querySelectorAll('.mg-badge')].map((badge) => badge.textContent)).toEqual(['킥오프', '내 팀']);
    expect(kick()!.disabled).toBe(true);
  });

  it('구경하는 사람에게는 차기와 내 팀이 없다', async () => {
    const { container, rows, kick } = await render(<SoccerPanel {...props(view({ team: null }), { me: null })} />);
    expect(kick()).toBeNull();
    expect(container.querySelector('.mg-badge')).toBeNull();
    expect(rows('점수').map((row) => row.getAttribute('aria-current'))).toEqual([null, null]);
  });

  it('끝나면 이긴 팀과 점수, 골을 넣은 사람을 보여 준다', async () => {
    const won: SoccerResult = {
      score: { a: 1, b: 3 },
      winner: 'b',
      scorers: [
        { id: friend.id, name: '친구', team: 'b', goals: 3 },
        { id: me.id, name: '나', team: 'a', goals: 1 },
      ],
    };
    const result = (outcome: SoccerResult): GameResultProps<SoccerView, SoccerResult> => ({ ...props(view()), result: outcome });
    const first = await render(<SoccerScore {...result(won)} />);
    expect(first.container.querySelector('.mg-soccer-verdict')!.textContent).toBe('B팀이 이겼어요');
    expect(first.rows('점수').map((row) => row.textContent)).toEqual(['A팀내 팀1', 'B팀3']);
    const goals = first.rows('골');
    expect(goals.map((row) => row.textContent)).toEqual(['친구3골', '나1골']);
    expect(goals.map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true']);
    expect(first.kick()).toBeNull();
    const draw = await render(<SoccerScore {...result({ score: { a: 0, b: 0 }, winner: null, scorers: [] })} />);
    expect(draw.container.querySelector('.mg-soccer-verdict')!.textContent).toBe('비겼어요');
    expect(draw.container.querySelector('[aria-label="골"]')).toBeNull();
  });
});

describe('축구의 F 키', () => {
  beforeEach(() => {
    clockNow = 50_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clockNow);
  });
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
    vi.restoreAllMocks();
  });

  function Keys({ enabled, act: send }: { enabled: boolean; act: (action: unknown) => boolean }) {
    useKickKey(enabled, send);
    return <input aria-label="말하기" />;
  }

  const press = (target: EventTarget, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    clockNow += 1_000;
    return event;
  };

  it('경기 중에는 F로 차고, 입력 중이거나 누르고 있거나 다른 키와 함께거나 세계가 쓴 F는 두고 간다', async () => {
    const send = vi.fn(() => true);
    const view = await render(<Keys enabled act={send} />);
    press(document.body);
    expect(send).toHaveBeenCalledWith({ kick: true });
    // By its place on the keyboard: a Korean layout's ㄹ is the same key.
    press(document.body, { key: 'ㄹ' });
    expect(send).toHaveBeenCalledTimes(2);
    press(view.container.querySelector('input')!);
    press(document.body, { repeat: true });
    press(document.body, { ctrlKey: true });
    press(document.body, { code: 'KeyG', key: 'g' });
    // The engine rides on F beside something rideable, and says so before the key reaches the window.
    const ride = (event: KeyboardEvent) => event.preventDefault();
    document.body.addEventListener('keydown', ride);
    expect(press(document.body).defaultPrevented).toBe(true);
    document.body.removeEventListener('keydown', ride);
    expect(send).toHaveBeenCalledTimes(2);
    // It takes nothing from the world's own keys.
    const move = press(document.body, { key: 'w', code: 'KeyW' });
    expect(move.defaultPrevented).toBe(false);
    expect(press(document.body).defaultPrevented).toBe(false);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('경기가 아닐 때는 F가 아무것도 하지 않는다', async () => {
    const send = vi.fn(() => true);
    const view = await render(<Keys enabled={false} act={send} />);
    press(document.body);
    expect(send).not.toHaveBeenCalled();
    await view.rerender(<Keys enabled act={send} />);
    press(document.body);
    expect(send).toHaveBeenCalledTimes(1);
    await view.rerender(<Keys enabled={false} act={send} />);
    press(document.body);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('축구 시작', () => {
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
  });

  it('방장의 시작은 섬의 빈 땅에 맞춘 경기장을 보낸다', async () => {
    const state: GameState = {
      session: { kind: 'soccer', phase: 'lobby', host: me.id, players: [me, friend], you: me.id, game: null, result: null, seq: 1, now: NOW },
      connected: true,
      error: null,
    };
    const client = {
      getState: () => state, subscribe: () => () => {}, open: vi.fn(() => true), join: vi.fn(() => true), leave: vi.fn(() => true),
      start: vi.fn((_layout: unknown) => true), act: vi.fn(() => true), close: vi.fn(() => true), onEvent: vi.fn(() => () => {}),
      serverNow: () => NOW, teleport: vi.fn(() => false), setTeleporter: vi.fn(() => () => {}), clearError: vi.fn(),
      connect: vi.fn(), disconnect: vi.fn(),
    } satisfies GameClient;
    const room: GameRoomValue = { client, live: true, building: createVillage, playerRef: { current: null } };
    const view = await render(
      <GameContext.Provider value={room}>
        <GameDock />
      </GameContext.Provider>,
    );
    await act(() => view.container.querySelector<HTMLButtonElement>('.mg-game-toggle')!.click());
    expect(view.container.querySelector('h2')!.textContent).toBe('축구');
    const start = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('시작'))!;
    expect(start.textContent).toBe('시작 2명');
    await act(() => start.click());
    expect(client.start).toHaveBeenCalledWith(findField(openSpots(createVillage()), null));
    expect(client.start.mock.calls[0]![0]).toMatchObject({ axis: 'x', halfLength: 18, halfWidth: 8 });
  });
});
