import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import type { GameProps } from '../game';
import type { KartEvent, KartOutcome, KartRacer, KartView } from '../kart';
import { KartLobby } from '../kart/Lobby';
import { KartOverlay } from '../kart/Overlay';
import { KartPanel, KartResult } from '../kart/Panel';
import type { GameSession, SessionPlayer } from '../protocol';

const NOW = 9_000_000;
const me: SessionPlayer = { id: 'me', name: '나', peer: 'peer-me' };
const players: SessionPlayer[] = [me, { id: 'b', name: '비', peer: 'peer-b' }];

const racer = (id: string, name: string, rank: number, changes: Partial<KartRacer> = {}): KartRacer => ({
  id,
  name,
  bot: false,
  color: rank - 1,
  lap: 0,
  next: 1,
  finishedAt: null,
  rank,
  boostUntil: 0,
  trappedUntil: 0,
  ...changes,
});

const game = (changes: Partial<KartView> = {}): KartView => ({
  phase: 'race',
  startsAt: NOW - 10_000,
  endsAt: NOW - 10_000 + 360_000,
  laps: 3,
  gates: 54,
  racers: [racer('x', '도토리', 1, { bot: true, lap: 1 }), racer('b', '비', 2, { lap: 1 }), racer('me', '나', 3, { lap: 1 }), racer('y', '감자', 4, { bot: true })],
  me: { lap: 1, next: 7, item: null },
  spawn: [-46, 80, 97.4],
  boxes: [],
  boosts: [],
  bots: [],
  ...changes,
});

function props(shown: KartView, clock = () => NOW) {
  const session: GameSession<KartView> = { kind: 'kart', phase: 'playing', host: me.id, players, you: me.id, game: shown, result: null, seq: 1, now: NOW };
  return {
    session,
    view: shown,
    me,
    act: vi.fn((_action: unknown) => true),
    onEvent: (_listener: (event: unknown) => void) => () => {},
    serverNow: clock,
    teleport: vi.fn(() => true),
    position: () => null,
    body: () => null,
  } satisfies GameProps<KartView>;
}

const mounted: { unmount: () => Promise<void> }[] = [];

async function overlay(shown: KartView, clock = () => NOW) {
  const given = props(shown, clock);
  let hear: (event: unknown) => void = () => {};
  given.onEvent = (listener: (event: unknown) => void) => {
    hear = listener;
    return () => {};
  };
  const view = await mount(<KartOverlay {...given} />);
  mounted.push(view);
  const text = (selector: string) => view.container.querySelector(selector)?.textContent ?? null;
  const show = (next: KartView) => view.rerender(<KartOverlay {...given} view={next} />);
  const announce = (event: KartEvent) => act(() => hear(event));
  return { view, text, show, announce, act: given.act };
}

describe('카트 화면', () => {
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
    vi.useRealTimers();
  });

  it('출발 전에는 3, 2, 1을 세고 출발을 잠깐 보여 준다', async () => {
    vi.useFakeTimers();
    let now = NOW;
    const shown = await overlay(game({ phase: 'countdown', startsAt: NOW + 2_500 }), () => now);
    expect(shown.text('.mg-kart-countdown')).toBe('3');
    now += 1_000;
    await act(() => vi.advanceTimersByTime(200));
    expect(shown.text('.mg-kart-countdown')).toBe('2');
    now += 1_000;
    await act(() => vi.advanceTimersByTime(200));
    expect(shown.text('.mg-kart-countdown')).toBe('1');
    now += 1_000;
    await shown.show(game({ startsAt: NOW + 2_500 }));
    await act(() => vi.advanceTimersByTime(200));
    expect(shown.text('.mg-kart-countdown')).toBe('출발');
    now += 1_000;
    await act(() => vi.advanceTimersByTime(200));
    expect(shown.text('.mg-kart-countdown')).toBeNull();
  });

  it('바퀴와 순위, 아이템 칸과 그 키를 보여 주고 누르면 쓴다', async () => {
    const shown = await overlay(game());
    expect(shown.text('.mg-kart-hud')).toBe('바퀴 2/33위/4');
    const slot = shown.view.container.querySelector<HTMLButtonElement>('.mg-kart-item')!;
    expect(slot.disabled).toBe(true);
    expect(slot.getAttribute('aria-label')).toBe('아이템 없음');
    await shown.show(game({ me: { lap: 2, next: 3, item: 'bubble' } }));
    expect(shown.text('.mg-kart-hud')).toBe('바퀴 3/33위/4');
    expect(slot.textContent).toBe('물풍선Space');
    expect(slot.disabled).toBe(false);
    await act(() => slot.click());
    expect(shown.act).toHaveBeenLastCalledWith({ do: 'item' });
    // The last lap stays the last lap.
    await shown.show(game({ me: { lap: 3, next: 1, item: null } }));
    expect(shown.text('.mg-kart-hud')).toBe('바퀴 3/33위/4');
  });

  it('부스터와 물풍선을 알리고, 들어오면 순위와 기록을 보여 준다', async () => {
    vi.useFakeTimers();
    const shown = await overlay(game());
    await shown.announce({ type: 'trapped', until: NOW + 1_500 });
    expect(shown.text('.mg-kart-splash')).toBe('물풍선');
    await act(() => vi.advanceTimersByTime(1_500));
    expect(shown.text('.mg-kart-splash')).toBeNull();
    await shown.announce({ type: 'boost', until: NOW + 2_000 });
    expect(shown.text('.mg-kart-splash')).toBe('부스터');
    const finished = game({ racers: [racer('me', '나', 1, { lap: 3, finishedAt: 83_456 }), racer('b', '비', 2)] });
    await shown.show(finished);
    expect([shown.text('.mg-kart-finish > b'), shown.text('.mg-kart-finish > span')]).toEqual(['1위', '1:23.45']);
    const board = [...shown.view.container.querySelectorAll('.mg-kart-board li')].map((row) => row.textContent);
    expect(board).toEqual(['1나1:23.45', '2비1/3']);
    expect(shown.view.container.querySelector('.mg-kart-item')).toBeNull();
    await shown.show(game({ phase: 'ended' }));
    expect(shown.view.container.innerHTML).toBe('');
  });

  it('패널은 순위와 바퀴를, 누가 들어오면 마감까지 남은 시간을 보여 준다', async () => {
    const view = await mount(<KartPanel {...props(game())} />);
    mounted.push(view);
    const rows = [...view.container.querySelectorAll('li')].map((row) => row.textContent);
    expect(rows).toEqual(['1위도토리봇2/3', '2위비2/3', '3위나2/3', '4위감자봇1/3']);
    expect(view.container.querySelector('li[aria-current="true"]')!.textContent).toContain('나');
    expect(view.container.querySelector('.mg-kart-closing')).toBeNull();
    const closing = game({ endsAt: NOW + 25_000, racers: [racer('x', '도토리', 1, { bot: true, lap: 3, finishedAt: 61_000 }), racer('me', '나', 2, { lap: 2 })] });
    await view.rerender(<KartPanel {...props(closing)} />);
    expect(view.container.querySelector('.mg-kart-closing')!.textContent).toBe('마감 0:25');
    expect(view.container.querySelector('li')!.textContent).toBe('1위도토리봇1:01.00');
  });

  it('결과는 들어온 기록과 못 들어온 바퀴를 순위대로 보여 준다', async () => {
    const result: KartOutcome = {
      ranking: [
        { id: 'x', name: '도토리', bot: true, rank: 1, finishedAt: 125_430, laps: 3 },
        { id: 'me', name: '나', bot: false, rank: 2, finishedAt: 131_005, laps: 3 },
        { id: 'y', name: '감자', bot: true, rank: 3, finishedAt: null, laps: 2 },
      ],
    };
    const view = await mount(<KartResult {...props(game({ phase: 'ended' }))} result={result} />);
    mounted.push(view);
    expect(view.container.querySelector('.mg-kart-place')!.textContent).toBe('2위2:11.00');
    expect([...view.container.querySelectorAll('li')].map((row) => row.textContent)).toEqual(['1위도토리봇2:05.43', '2위나2:11.00', '3위감자봇2/3바퀴']);
  });

  it('대기실에서 방장은 봇과 바퀴 수를 정하고, 혼자면 넷이 달리게 봇 셋이 기본이다', async () => {
    const lobbySession = (people: number) =>
      ({ kind: 'kart', phase: 'lobby', host: 'p0', players: Array.from({ length: people }, (_, index) => ({ id: `p${index}`, name: `p${index}`, peer: null })), you: 'p0', game: null, result: null, seq: 1, now: 0 }) as GameSession;
    const setOptions = vi.fn();
    const view = await mount(<KartLobby session={lobbySession(1)} options={undefined} setOptions={setOptions} />);
    mounted.push(view);
    const button = (name: string) => view.container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
    expect(view.container.querySelector('.mg-kart-count')!.textContent).toBe('4/8');
    await act(() => button('봇 더하기').click());
    expect(setOptions).toHaveBeenLastCalledWith({ bots: 4, laps: 3 });
    await act(() => button('바퀴 빼기').click());
    expect(setOptions).toHaveBeenLastCalledWith({ bots: 3, laps: 2 });
    await view.rerender(<KartLobby session={lobbySession(1)} options={{ bots: 7, laps: 5 }} setOptions={setOptions} />);
    expect([button('봇 더하기').disabled, button('바퀴 더하기').disabled]).toEqual([true, true]);
    await view.rerender(<KartLobby session={lobbySession(8)} options={{ bots: 3, laps: 1 }} setOptions={setOptions} />);
    expect([button('봇 더하기').disabled, button('봇 빼기').disabled, button('바퀴 빼기').disabled]).toEqual([true, true, true]);
    expect(view.container.querySelector('.mg-kart-count')!.textContent).toBe('8/8');
  });
});
