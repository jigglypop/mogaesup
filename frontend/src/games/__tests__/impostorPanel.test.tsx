import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount, type } from '../../__tests__/mount';
import type { GameProps } from '../game';
import { ImpostorPanel, ImpostorResult } from '../impostor/Panel';
import type { ImpostorMeeting, ImpostorOutcome, ImpostorView } from '../impostor';
import type { GameSession, SessionPlayer } from '../protocol';

const NOW = 7_000_000;
const me: SessionPlayer = { id: 'me', name: '나', peer: 'peer-me' };
const players: SessionPlayer[] = [me, { id: 'b', name: '비', peer: 'peer-b' }, { id: 'c', name: '씨', peer: 'peer-c' }, { id: 'd', name: '디', peer: 'peer-d' }];

const game = (changes: Partial<ImpostorView> = {}): ImpostorView => ({
  phase: 'play',
  role: 'crew',
  impostors: null,
  alive: true,
  tasks: [{ station: 2, done: true }, { station: 5, done: false }, { station: 0, done: false }, { station: 7, done: false }],
  working: null,
  progress: { done: 3, total: 12 },
  players: players.map(({ id, name }) => ({ id, name, alive: true })),
  dead: [],
  bodies: [],
  table: [0, 0, 0],
  stations: Array.from({ length: 8 }, (_, index) => [index * 8, 0, 20]),
  meeting: null,
  talk: [],
  lastMeeting: null,
  kill: null,
  near: { station: null, body: null, table: false },
  emergencyLeft: 1,
  emergencyFrom: NOW - 1,
  ...changes,
});

const meeting = (changes: Partial<ImpostorMeeting> = {}): ImpostorMeeting => ({
  number: 1,
  stage: 'discuss',
  caller: 'b',
  callerName: '비',
  reason: 'report',
  body: { victim: 'd', name: '디' },
  endsAt: NOW + 25_000,
  seat: [1.6, 0, 0],
  voted: 0,
  voters: 3,
  myVote: null,
  ...changes,
});

function props(shown: ImpostorView, you = me.id) {
  const session: GameSession<ImpostorView> = { kind: 'impostor', phase: 'playing', host: me.id, players, you, game: shown, result: null, seq: 1, now: NOW };
  return {
    session,
    view: shown,
    me: players.find((player) => player.id === you) ?? null,
    act: vi.fn((_action: unknown) => true),
    onEvent: () => () => {},
    serverNow: () => NOW,
    teleport: vi.fn(() => true),
  } satisfies GameProps<ImpostorView>;
}

const mounted: { unmount: () => Promise<void> }[] = [];

async function panel(shown: ImpostorView, you = me.id) {
  const given = props(shown, you);
  const view = await mount(<ImpostorPanel {...given} />);
  mounted.push(view);
  const buttons = () => [...view.container.querySelectorAll('button')];
  const button = (name: string) => buttons().find((item) => item.textContent?.trim().startsWith(name) || item.getAttribute('aria-label') === name);
  const press = (name: string) => act(() => button(name)!.click());
  const text = (selector: string) => [...view.container.querySelectorAll(selector)].map((item) => item.textContent);
  const show = (next: ImpostorView) => view.rerender(<ImpostorPanel {...given} view={next} />);
  return { view, act: given.act, buttons, button, press, text, show };
}

describe('임포스터 패널', () => {
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
  });

  it('크루는 역할, 전체 진행, 내 작업을 보고 가까운 작업을 시작한다', async () => {
    const { view: shown, button, press, text, show, act: sent } = await panel(game());
    expect(text('.mg-impostor-role')).toEqual(['크루']);
    const bar = shown.container.querySelector('[role="progressbar"]')!;
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['3', '12']);
    expect(shown.container.querySelector('.mg-impostor-progress b')!.textContent).toBe('3/12');
    expect(shown.container.querySelector('.mg-impostor-tasks')!.getAttribute('aria-label')).toBe('내 작업');
    expect(text('.mg-impostor-tasks li')).toEqual(['작업 1완료', '작업 2', '작업 3', '작업 4']);
    // Nothing in reach: the buttons wait; crew have no 처치.
    expect(button('작업')!.disabled).toBe(true);
    expect(button('신고')!.disabled).toBe(true);
    expect(button('긴급 회의')!.disabled).toBe(true);
    expect(button('처치')).toBeUndefined();
    await show(game({ near: { station: 5, body: null, table: false } }));
    await press('작업');
    expect(sent).toHaveBeenLastCalledWith({ do: 'task' });
    // Underway: the task counts down.
    await show(game({ near: { station: 5, body: null, table: false }, working: { station: 5, endsAt: NOW + 2_100 } }));
    expect(button('작업 중')!.textContent).toBe('작업 중 3');
    expect(button('작업 중')!.disabled).toBe(true);
    expect(text('.mg-impostor-tasks li')[1]).toBe('작업 23초');
    // A body and the table in reach.
    await show(game({ near: { station: null, body: 2, table: true } }));
    await press('신고');
    expect(sent).toHaveBeenLastCalledWith({ do: 'report', body: 2 });
    await press('긴급 회의');
    expect(sent).toHaveBeenLastCalledWith({ do: 'meeting' });
    // Too soon after a meeting, and once it is spent.
    await show(game({ near: { station: null, body: null, table: true }, emergencyFrom: NOW + 9_000 }));
    expect(button('긴급 회의')!.textContent).toBe('긴급 회의 9');
    expect(button('긴급 회의')!.disabled).toBe(true);
    await show(game({ near: { station: null, body: null, table: true }, emergencyLeft: 0 }));
    expect(button('긴급 회의')!.textContent).toBe('긴급 회의');
    expect(button('긴급 회의')!.disabled).toBe(true);
  });

  it('임포스터는 동료와 가짜 작업을 보고, 기다린 뒤 가장 가까운 크루를 처치한다', async () => {
    const impostor = game({ role: 'impostor', impostors: ['me', 'c'], kill: { readyAt: NOW + 12_000, targets: ['b'] } });
    const { view: shown, button, press, text, show, act: sent } = await panel(impostor);
    expect(text('.mg-impostor-role')).toEqual(['임포스터동료 씨']);
    expect(shown.container.querySelector('.mg-impostor-tasks')!.getAttribute('aria-label')).toBe('가짜 작업');
    expect(text('.mg-impostor-tasks li')[1]).toBe('가짜 작업 2');
    expect(button('작업')).toBeUndefined();
    expect(button('처치')!.textContent).toBe('처치 12');
    expect(button('처치')!.disabled).toBe(true);
    await show({ ...impostor, kill: { readyAt: NOW - 1, targets: ['b', 'd'] } });
    expect(button('처치')!.textContent).toBe('처치 · 비');
    await press('처치');
    expect(sent).toHaveBeenLastCalledWith({ do: 'kill', target: 'b' });
    await show({ ...impostor, kill: { readyAt: NOW - 1, targets: [] } });
    expect(button('처치')!.disabled).toBe(true);
  });

  it('탈락한 크루는 작업을 이어 하고, 유령끼리만 말한다', async () => {
    const ghost = game({
      alive: false,
      dead: ['me'],
      near: { station: 0, body: null, table: false },
      talk: [{ id: 4, from: 'd', name: '디', text: '여기도 있어요', ghost: true }],
    });
    const { view: shown, button, press, text, act: sent } = await panel(ghost);
    expect(text('.mg-impostor-role')).toEqual(['크루탈락']);
    expect(button('작업')!.disabled).toBe(false);
    expect(button('신고')).toBeUndefined();
    expect(button('긴급 회의')).toBeUndefined();
    expect(shown.container.querySelector('.mg-impostor-talk')!.getAttribute('aria-label')).toBe('유령 대화');
    expect(text('.mg-impostor-talk li')).toEqual(['유령디여기도 있어요']);
    const field = shown.container.querySelector<HTMLInputElement>('.mg-impostor-talk input')!;
    expect(field.maxLength).toBe(120);
    expect(button('보내기')!.disabled).toBe(true);
    await type(field, '  비가 범인이에요 ');
    await press('보내기');
    expect(sent).toHaveBeenLastCalledWith({ do: 'say', text: '비가 범인이에요' });
    expect(field.value).toBe('');
    // Keys typed into the line stay out of the island's controls (they listen on the document); Escape still goes on.
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    await act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true })));
    expect(heard).not.toHaveBeenCalled();
    await act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(heard).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', heard);
  });

  it('회의의 토론에는 누가 왜 열었는지, 남은 시간과 대화만 있고 투표는 아직 없다', async () => {
    const talk = [{ id: 1, from: 'b', name: '비', text: '디가 쓰러져 있었어요', ghost: false }];
    const { view: shown, buttons, press, text, act: sent } = await panel(game({ phase: 'discuss', meeting: meeting(), dead: ['d'], talk }));
    expect(text('.mg-impostor-head')).toEqual(['비님이 디님을 신고했어요']);
    const timer = shown.container.querySelector('[role="timer"]')!;
    expect([timer.getAttribute('aria-label'), timer.textContent]).toEqual(['토론 남은 시간', '0:25']);
    expect(text('.mg-impostor-seats li')).toEqual(['나', '비', '씨', '디탈락']);
    expect(shown.container.querySelector('.mg-impostor-seats li[aria-current="true"]')!.textContent).toBe('나');
    expect(buttons().map((item) => item.textContent)).toEqual(['보내기']);
    expect(text('.mg-impostor-talk li')).toEqual(['비디가 쓰러져 있었어요']);
    await type(shown.container.querySelector<HTMLInputElement>('.mg-impostor-talk input')!, '저는 위에 있었어요');
    await press('보내기');
    expect(sent).toHaveBeenLastCalledWith({ do: 'say', text: '저는 위에 있었어요' });
  });

  it('투표에서는 살아 있는 사람에게 한 번 투표하거나 건너뛰고, 누가 누구에게 냈는지는 보이지 않는다', async () => {
    const voting = game({ phase: 'vote', dead: ['d'], meeting: meeting({ stage: 'vote', reason: 'emergency', body: null, endsAt: NOW + 30_000, voted: 1 }) });
    const { view: shown, button, press, text, show, act: sent } = await panel(voting);
    expect(text('.mg-impostor-head')).toEqual(['비님이 긴급 회의를 열었어요']);
    expect(shown.container.querySelector('[role="timer"]')!.getAttribute('aria-label')).toBe('투표 남은 시간');
    expect(text('.mg-impostor-count')).toEqual(['투표한 사람 1/3']);
    expect(['나 투표', '비 투표', '씨 투표'].map((name) => !!button(name))).toEqual([true, true, true]);
    expect(button('디 투표')).toBeUndefined();
    await press('비 투표');
    expect(sent).toHaveBeenLastCalledWith({ do: 'vote', target: 'b' });
    await press('건너뛰기');
    expect(sent).toHaveBeenLastCalledWith({ do: 'vote', target: null });
    // Voted: the choice is marked and nothing more is offered.
    await show({ ...voting, meeting: meeting({ stage: 'vote', voted: 2, myVote: { target: 'b' } }) });
    expect(button('비 투표')).toBeUndefined();
    expect(button('건너뛰기')!.disabled).toBe(true);
    expect(text('.mg-impostor-seats li')[1]).toBe('비내 표');
    await show({ ...voting, meeting: meeting({ stage: 'vote', voted: 2, myVote: { target: null } }) });
    expect(text('.mg-game-actions .mg-badge')).toEqual(['건너뛰었어요']);
  });

  it('죽은 사람과 구경하는 사람은 투표하지 않는다', async () => {
    const voting = meeting({ stage: 'vote', seat: null });
    const ghost = await panel(game({ phase: 'vote', alive: false, dead: ['me'], meeting: voting }));
    expect(ghost.buttons().map((item) => item.textContent)).toEqual(['보내기']);
    expect(ghost.view.container.querySelector('.mg-impostor-talk')!.getAttribute('aria-label')).toBe('유령 대화');
    const onlooker = await panel(game({ phase: 'vote', role: null, alive: null, tasks: [], emergencyLeft: 0, meeting: voting }), 'watcher');
    expect(onlooker.buttons()).toEqual([]);
    expect(onlooker.view.container.querySelector('.mg-impostor-role')).toBeNull();
    const playing = await panel(game({ role: null, alive: null, tasks: [], emergencyLeft: 0 }), 'watcher');
    expect(playing.buttons()).toEqual([]);
    expect(playing.view.container.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('회의가 끝나면 누가 추방됐는지와 누가 누구에게 투표했는지 보인다', async () => {
    const votes = [
      { voter: 'me', target: 'c' },
      { voter: 'b', target: 'c' },
      { voter: 'c', target: null },
    ];
    const { text, show } = await panel(game({ lastMeeting: { number: 1, ejected: 'c', name: '씨', impostor: true, votes } }));
    expect(text('.mg-impostor-verdict p')).toEqual(['씨님이 추방됐어요 · 임포스터였어요']);
    expect(text('.mg-impostor-tally li')).toEqual(['씨나, 비2표', '건너뛰기씨1표']);
    await show(game({ lastMeeting: { number: 2, ejected: null, name: null, impostor: null, votes: [] } }));
    expect(text('.mg-impostor-verdict p')).toEqual(['아무도 추방되지 않았어요']);
    expect(text('.mg-impostor-tally li')).toEqual([]);
  });

  it('끝나면 이긴 편과 이유, 모두의 역할을 보여 준다', async () => {
    const result: ImpostorOutcome = {
      winner: 'impostor',
      reason: 'parity',
      players: [
        { id: 'me', name: '나', role: 'crew', alive: false, left: false },
        { id: 'b', name: '비', role: 'impostor', alive: true, left: false },
        { id: 'c', name: '씨', role: 'crew', alive: true, left: false },
        { id: 'd', name: '디', role: 'crew', alive: false, left: true },
      ],
    };
    const ended = await mount(<ImpostorResult {...props(game({ phase: 'ended' }))} result={result} />);
    mounted.push(ended);
    expect(ended.container.querySelector('[role="status"]')!.textContent).toBe('임포스터가 이겼어요패배');
    expect(ended.container.querySelector('.mg-muted')!.textContent).toBe('임포스터가 크루만큼 남았어요');
    const rows = [...ended.container.querySelectorAll('.mg-game-scores li')];
    expect(rows.map((row) => row.textContent)).toEqual(['나탈락크루', '비임포스터', '씨크루', '디나감크루']);
    expect(rows[0]!.getAttribute('aria-current')).toBe('true');
  });
});
