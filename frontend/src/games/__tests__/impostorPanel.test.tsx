import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount, type } from '../../__tests__/mount';
import { ImpostorPanel, ImpostorResult } from '../impostor/Panel';
import type { ImpostorMeeting, ImpostorOutcome, ImpostorView } from '../impostor';
import { game, me, NOW, players, props } from './impostorView';

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

  it('크루는 역할, 전체 진행, 내 작업과 그 종류를 본다', async () => {
    const { view: shown, buttons, text, show } = await panel(game());
    expect(text('.mg-impostor-role')).toEqual(['크루']);
    const bar = shown.container.querySelector('[role="progressbar"]')!;
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['3', '12']);
    expect(shown.container.querySelector('.mg-impostor-progress b')!.textContent).toBe('3/12');
    expect(shown.container.querySelector('.mg-impostor-tasks')!.getAttribute('aria-label')).toBe('내 작업');
    expect(text('.mg-impostor-tasks li')).toEqual(['데이터 받기완료', '연료 채우기', '전선 연결', '카드 긁기']);
    // The buttons are over the island, not here.
    expect(buttons()).toEqual([]);
    // Underway: the task counts down to when it may be finished.
    await show(game({ working: { station: 5, kind: 'fuel', readyAt: NOW + 2_100 } }));
    expect(text('.mg-impostor-tasks li')[1]).toBe('연료 채우기3초');
    // The comms down: no task bar, no task list, what is broken instead.
    await show(game({ progress: null, sabotage: { kind: 'comms', endsAt: null, held: [false, false] } }));
    expect(shown.container.querySelector('[role="progressbar"]')).toBeNull();
    expect(shown.container.querySelector('.mg-impostor-tasks')).toBeNull();
    expect(text('.mg-impostor-broken')).toEqual(['통신 방해']);
  });

  it('임포스터는 동료와 가짜 작업을 본다', async () => {
    const impostor = game({ role: 'impostor', impostors: ['me', 'c'], kill: { readyAt: NOW + 12_000, targets: ['b'] } });
    const { view: shown, text } = await panel(impostor);
    expect(text('.mg-impostor-role')).toEqual(['임포스터동료 씨']);
    expect(shown.container.querySelector('.mg-impostor-tasks')!.getAttribute('aria-label')).toBe('가짜 작업');
    expect(text('.mg-impostor-tasks li')[1]).toBe('연료 채우기');
  });

  it('탈락한 크루는 유령끼리만 말한다', async () => {
    const ghost = game({
      alive: false,
      talk: [{ id: 4, from: 'd', name: '디', text: '여기도 있어요', ghost: true }],
    });
    const { view: shown, button, press, text, act: sent } = await panel(ghost);
    expect(text('.mg-impostor-role')).toEqual(['크루탈락']);
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
    const known = players.map(({ id, name }) => ({ id, name, alive: id !== 'd', bot: id === 'c' }));
    const { view: shown, buttons, press, text, act: sent } = await panel(game({ phase: 'discuss', meeting: meeting(), players: known, talk }));
    expect(text('.mg-impostor-head')).toEqual(['비님이 디님을 신고했어요']);
    const timer = shown.container.querySelector('[role="timer"]')!;
    expect([timer.getAttribute('aria-label'), timer.textContent]).toEqual(['토론 남은 시간', '0:25']);
    expect(text('.mg-impostor-seats li')).toEqual(['나', '비', '씨봇', '디탈락']);
    expect(shown.container.querySelector('.mg-impostor-seats li[aria-current="true"]')!.textContent).toBe('나');
    expect(buttons().map((item) => item.textContent)).toEqual(['보내기']);
    expect(text('.mg-impostor-talk li')).toEqual(['비디가 쓰러져 있었어요']);
    await type(shown.container.querySelector<HTMLInputElement>('.mg-impostor-talk input')!, '저는 위에 있었어요');
    await press('보내기');
    expect(sent).toHaveBeenLastCalledWith({ do: 'say', text: '저는 위에 있었어요' });
  });

  it('투표에서는 살아 있는 사람에게 한 번 투표하거나 건너뛰고, 누가 누구에게 냈는지는 보이지 않는다', async () => {
    const known = players.map(({ id, name }) => ({ id, name, alive: id !== 'd', bot: false }));
    const voting = game({ phase: 'vote', players: known, meeting: meeting({ stage: 'vote', reason: 'emergency', body: null, endsAt: NOW + 30_000, voted: 1 }) });
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
    const ghost = await panel(game({ phase: 'vote', alive: false, meeting: voting }));
    expect(ghost.buttons().map((item) => item.textContent)).toEqual(['보내기']);
    expect(ghost.view.container.querySelector('.mg-impostor-talk')!.getAttribute('aria-label')).toBe('유령 대화');
    const onlooker = await panel(game({ phase: 'vote', role: null, alive: null, tasks: [], emergencyLeft: 0, meeting: voting }), 'watcher');
    expect(onlooker.buttons()).toEqual([]);
    expect(onlooker.view.container.querySelector('.mg-impostor-role')).toBeNull();
    const playing = await panel(game({ role: null, alive: null, tasks: [], emergencyLeft: 0 }), 'watcher');
    expect(playing.buttons()).toEqual([]);
    const melted = await mount(
      <ImpostorResult {...props(game({ phase: 'ended' }))} result={{ winner: 'impostor', reason: 'meltdown', players: [] }} />,
    );
    mounted.push(melted);
    expect(melted.container.querySelector('.mg-muted')!.textContent).toBe('원자로가 녹아내렸어요');
    expect(playing.view.container.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('회의가 끝나면 누가 추방됐는지와 누가 누구에게 투표했는지 보인다', async () => {
    const votes = [
      { voter: 'me', target: 'c' },
      { voter: 'b', target: 'c' },
      { voter: 'c', target: null },
    ];
    const { text, show } = await panel(game({ lastMeeting: { number: 1, ejected: 'c', name: '씨', impostor: true, remaining: 1, votes } }));
    expect(text('.mg-impostor-verdict p')).toEqual(['씨님이 추방됐어요 · 임포스터였어요 임포스터 1명 남음']);
    expect(text('.mg-impostor-tally li')).toEqual(['씨나, 비2표', '건너뛰기씨1표']);
    await show(game({ lastMeeting: { number: 2, ejected: null, name: null, impostor: null, remaining: 2, votes: [] } }));
    expect(text('.mg-impostor-verdict p')).toEqual(['아무도 추방되지 않았어요 임포스터 2명 남음']);
    expect(text('.mg-impostor-tally li')).toEqual([]);
  });

  it('끝나면 이긴 편과 이유, 모두의 역할을 보여 준다', async () => {
    const result: ImpostorOutcome = {
      winner: 'impostor',
      reason: 'parity',
      players: [
        { id: 'me', name: '나', role: 'crew', alive: false, left: false, bot: false },
        { id: 'b', name: '비', role: 'impostor', alive: true, left: false, bot: false },
        { id: 'c', name: '씨', role: 'crew', alive: true, left: false, bot: true },
        { id: 'd', name: '디', role: 'crew', alive: false, left: true, bot: false },
      ],
    };
    const ended = await mount(<ImpostorResult {...props(game({ phase: 'ended' }))} result={result} />);
    mounted.push(ended);
    expect(ended.container.querySelector('[role="status"]')!.textContent).toBe('임포스터가 이겼어요패배');
    expect(ended.container.querySelector('.mg-muted')!.textContent).toBe('임포스터가 크루만큼 남았어요');
    const rows = [...ended.container.querySelectorAll('.mg-game-scores li')];
    expect(rows.map((row) => row.textContent)).toEqual(['나탈락크루', '비임포스터', '씨봇크루', '디나감크루']);
    expect(rows[0]!.getAttribute('aria-current')).toBe('true');
  });
});

describe('임포스터 패널 부르기', () => {
  it('회의마다 한 번씩 접어 둔 패널을 부르고, 회의가 없거나 끝나면 부르지 않는다', async () => {
    const { impostor } = await import('../impostor');
    const meeting = (number: number) => ({ number }) as unknown as ImpostorMeeting;
    expect(impostor.attention!({ phase: 'play', meeting: null })).toBeNull();
    expect(impostor.attention!({ phase: 'discuss', meeting: meeting(1) })).toBe('meeting-1');
    expect(impostor.attention!({ phase: 'vote', meeting: meeting(1) })).toBe('meeting-1');
    expect(impostor.attention!({ phase: 'discuss', meeting: meeting(2) })).toBe('meeting-2');
    expect(impostor.attention!({ phase: 'ended', meeting: meeting(2) })).toBeNull();
  });
});
