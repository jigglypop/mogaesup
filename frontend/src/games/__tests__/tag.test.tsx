import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { createVillage } from '../../minihome/village';
import type { GameProps } from '../game';
import type { GameSession } from '../protocol';
import { gameOf } from '../registry';
import { openSpots } from '../spots';
import { tag, type TagResult, type TagView } from '../tag';
import { TagOutcome, TagPanel } from '../tag/Panel';
import { ringed } from '../tag/World';

const NOW = 7_000_000;
const me = { id: 'me', name: '나', peer: 'peer-me' };
const friend = { id: 'friend', name: '친구', peer: 'peer-friend' };
const away = { id: 'away', name: '멀리', peer: null };

const view = (changes: Partial<TagView> = {}): TagView => ({
  role: 'runner',
  spot: [4, 0, 8],
  its: [friend.id],
  runners: [me.id, away.id],
  counts: { its: 1, runners: 2 },
  safeUntil: NOW + 4_200,
  endsAt: NOW + 148_200,
  ...changes,
});

function props(game: TagView, you = me.id): GameProps<TagView> {
  const session: GameSession<TagView> = {
    kind: 'tag', phase: 'playing', host: me.id, players: [me, friend, away], you, game, result: null, seq: 1, now: NOW,
  };
  return {
    session, view: game, me: session.players.find((player) => player.id === you) ?? null,
    act: vi.fn(() => true), onEvent: () => () => {}, serverNow: () => NOW, teleport: vi.fn(() => true),
  };
}

const mounted: { unmount: () => Promise<void> }[] = [];

async function panel(game: TagView, you = me.id) {
  const shown = await mount(<TagPanel {...props(game, you)} />);
  mounted.push(shown);
  const timer = () => shown.container.querySelector('[role="timer"]')!;
  const rows = () => [...shown.container.querySelectorAll('.mg-game-scores li')].map((row) => row.textContent);
  return { shown, timer, rows, rerender: (next: TagView) => shown.rerender(<TagPanel {...props(next, you)} />) };
}

describe('술래잡기', () => {
  afterEach(async () => {
    for (const shown of mounted.splice(0)) await shown.unmount();
  });

  it('출발 전에는 내 역할과 술래가 출발하기까지 남은 시간, 술래와 도망자 수를 보여 준다', async () => {
    const { shown, timer, rows } = await panel(view());
    expect(shown.container.querySelector('.mg-tag-role.is-runner')!.textContent).toBe('도망자예요');
    expect(shown.container.querySelector('.mg-tag-clock > span')!.textContent).toBe('술래 출발까지');
    expect(timer().textContent).toBe('0:05');
    expect(timer().getAttribute('aria-label')).toBe('술래 출발까지');
    expect(rows()).toEqual(['술래1', '도망자2']);
  });

  it('출발 뒤에는 남은 시간을 세고, 잡히면 술래가 되며, 구경하는 사람에게는 역할이 없다', async () => {
    const started = { safeUntil: NOW - 100, spot: null };
    const { shown, timer, rows, rerender } = await panel(view(started));
    expect(shown.container.querySelector('.mg-tag-clock > span')).toBeNull();
    expect(timer().textContent).toBe('2:29');
    expect(timer().getAttribute('aria-label')).toBe('남은 시간');
    await rerender(view({ ...started, role: 'it', its: [friend.id, me.id], runners: [away.id], counts: { its: 2, runners: 1 } }));
    expect(shown.container.querySelector('.mg-tag-role.is-it')!.textContent).toBe('술래예요');
    expect(rows()).toEqual(['술래2', '도망자1']);
    const watching = await panel(view({ ...started, role: null }), 'watcher');
    expect(watching.shown.container.querySelector('.mg-tag-role')).toBeNull();
  });

  it('끝나면 이긴 쪽, 남은 도망자, 늦게 잡힌 사람부터 잡힌 때, 처음 술래를 보여 준다', async () => {
    const result: TagResult = {
      winner: 'runners',
      runners: [{ id: me.id, name: '나' }],
      its: [{ id: friend.id, name: '친구' }],
      caught: [
        { id: 'c', name: '셋', by: friend.id, byName: '친구', time: 6_000 },
        { id: 'd', name: '넷', by: 'c', byName: '셋', time: 83_900 },
      ],
    };
    const shown = await mount(<TagOutcome {...props(view())} result={result} />);
    mounted.push(shown);
    expect(shown.container.querySelector('.mg-tag-winner')!.textContent).toBe('도망자가 이겼어요');
    const rows = [...shown.container.querySelectorAll('.mg-game-scores li')];
    expect(rows.map((row) => row.textContent)).toEqual(['생존나', '잡힘넷1:23', '잡힘셋0:06', '술래친구']);
    expect(rows[0]!.getAttribute('aria-current')).toBe('true');
    await shown.rerender(<TagOutcome {...props(view())} result={{ ...result, winner: 'its', runners: [] }} />);
    expect(shown.container.querySelector('.mg-tag-winner.is-its')!.textContent).toBe('술래가 이겼어요');
  });

  it('술래마다 고리를 그릴 아바타는 그 사람의 실시간 방 client id이고, 내가 술래면 내 캐릭터다', () => {
    const game = view({ its: [friend.id, me.id, away.id] });
    expect(ringed(game, props(game).session)).toEqual([
      { id: friend.id, peer: 'peer-friend', self: false },
      { id: me.id, peer: 'peer-me', self: true },
      { id: away.id, peer: null, self: false },
    ]);
  });

  it('방장의 배치는 섬의 빈 자리들이다', () => {
    const building = createVillage();
    const spots = openSpots(building, { bounds: () => undefined });
    const session = { kind: 'tag' } as GameSession;
    expect(gameOf('tag')).toBe(tag);
    expect(tag.layout({ building, spots: () => spots, position: null, session })).toEqual({ spots });
    expect(spots.length).toBeGreaterThanOrEqual(12);
    expect([tag.minPlayers, tag.maxPlayers]).toEqual([3, 30]);
  });
});
