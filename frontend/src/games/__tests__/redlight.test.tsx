import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { createVillage } from '../../minihome/village';
import type { GameProps } from '../game';
import type { GameSession, Vec3 } from '../protocol';
import { redlight, type RedlightResult, type RedlightView } from '../redlight';
import { RedlightPanel, RedlightRanking } from '../redlight/Panel';
import { findTrack, LONGEST, openGround, SHORTEST, wallsOf, type Segment, type Track } from '../redlight/track';
import { useArrive } from '../redlight/World';
import { gameOf } from '../registry';
import { openSpots } from '../spots';

const NOW = 5_000_000;
const me = { id: 'me', name: '나', peer: 'peer-me' };
const friend = { id: 'friend', name: '친구', peer: 'peer-friend' };

const view = (changes: Partial<RedlightView> = {}): RedlightView => ({
  phase: 'ready',
  phaseEndsAt: NOW + 7_200,
  endsAt: NOW + 97_200,
  track: { start: [0, 0, 0], finish: [20, 0, 0] },
  slot: [0, 0, -0.5],
  state: 'running',
  finished: [],
  out: [],
  counts: { running: 2, finished: 0, out: 0 },
  ...changes,
});

function props(game: RedlightView, you = me.id): GameProps<RedlightView> {
  const session: GameSession<RedlightView> = {
    kind: 'redlight', phase: 'playing', host: me.id, players: [me, friend], you, game, result: null, seq: 1, now: NOW,
  };
  return {
    session, view: game, me: session.players.find((player) => player.id === you) ?? null,
    act: vi.fn(() => true), onEvent: () => () => {}, serverNow: () => NOW, teleport: vi.fn(() => true),
  };
}

const mounted: { unmount: () => Promise<void> }[] = [];

async function panel(game: RedlightView, you = me.id) {
  const shown = await mount(<RedlightPanel {...props(game, you)} />);
  mounted.push(shown);
  const text = (selector: string) => shown.container.querySelector(selector)?.textContent ?? null;
  const rows = () => [...shown.container.querySelectorAll('.mg-game-scores li')].map((row) => row.textContent);
  return { shown, text, rows, rerender: (next: RedlightView) => shown.rerender(<RedlightPanel {...props(next, you)} />) };
}

const unmeasured = { bounds: () => undefined };
const length = ({ start, finish }: Track) => Math.hypot(finish[0] - start[0], finish[2] - start[2]);
/** Spots 4 m apart along x at height-less z, from `from` to `to`. */
const row = (z: number, from: number, to: number): Vec3[] =>
  Array.from({ length: (to - from) / 4 + 1 }, (_, index) => [from + index * 4, 0, z] as Vec3);
/** Whether every point of the line from `a` to `b` (every 10 cm) lies on open ground. */
function overOpenGround(spots: readonly Vec3[], a: Vec3, b: Vec3) {
  const open = openGround(spots);
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 0.1);
  return Array.from({ length: steps + 1 }, (_, step) => step / steps).every((t) => open(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t));
}
/** Open ground four meters to each side of the start, across the track. */
function roomAtStart(spots: readonly Vec3[], { start, finish }: Track) {
  const [x, z] = [-(finish[2] - start[2]) / length({ start, finish }), (finish[0] - start[0]) / length({ start, finish })];
  return overOpenGround(spots, [start[0] - x * 4, 0, start[2] - z * 4], [start[0] + x * 4, 0, start[2] + z * 4]);
}
const ends = ({ start, finish }: Track) => [start, finish].map((point) => point.join()).sort();

describe('무궁화 꽃이 피었습니다', () => {
  afterEach(async () => {
    for (const shown of mounted.splice(0)) await shown.unmount();
  });

  it('준비에는 준비와 출발까지 남은 시간, 내 상태와 인원을 보여 준다', async () => {
    const { shown, text, rows } = await panel(view());
    const call = shown.container.querySelector('.mg-redlight-call')!;
    expect(call.textContent).toBe('준비');
    expect(call.getAttribute('role')).toBe('status');
    const timer = shown.container.querySelector('[role="timer"]')!;
    expect(timer.textContent).toBe('0:08');
    expect(timer.getAttribute('aria-label')).toBe('출발까지');
    expect(text('.mg-redlight-state')).toBe('달리는 중이에요');
    expect(rows()).toEqual(['달리는 중2', '도착0', '탈락0']);
  });

  it('초록불이면 무궁화 꽃이 피었습니다, 빨간불이면 멈춤을 크게 부르고 남은 경기 시간을 센다', async () => {
    const { shown, text, rerender } = await panel(view({ phase: 'green', phaseEndsAt: NOW + 3_000, slot: null }));
    expect(text('.mg-redlight-call.is-green')).toBe('무궁화 꽃이 피었습니다');
    const timer = () => shown.container.querySelector('[role="timer"]')!;
    expect(timer().textContent).toBe('1:38');
    expect(timer().getAttribute('aria-label')).toBe('남은 시간');
    await rerender(view({ phase: 'red', phaseEndsAt: NOW + 2_500, slot: null }));
    expect(text('.mg-redlight-call.is-red')).toBe('멈춤');
    expect(timer().textContent).toBe('1:38');
  });

  it('도착하면 순위와 시간을, 탈락하면 탈락을 보이고 구경하는 사람에게는 상태를 두지 않는다', async () => {
    const finished = [{ id: friend.id, name: '친구', time: 9_000 }, { id: me.id, name: '나', time: 12_340 }];
    const arrived = view({ phase: 'red', state: 'finished', finished, counts: { running: 0, finished: 2, out: 0 } });
    const { text, rows, rerender } = await panel(arrived);
    expect(text('.mg-redlight-state.is-finished')).toBe('도착했어요 · 2위 12.3초');
    expect(rows()).toEqual(['달리는 중0', '도착2', '탈락0']);
    await rerender(view({ phase: 'green', state: 'out', out: [{ id: me.id, name: '나' }] }));
    expect(text('.mg-redlight-state.is-out')).toBe('탈락했어요');
    const watching = await panel(view({ state: null, slot: null }), 'watcher');
    expect(watching.text('.mg-redlight-state')).toBeNull();
    expect(watching.text('.mg-redlight-call')).toBe('준비');
  });

  it('끝나면 도착한 순서와 시간, 도착하지 못한 사람, 탈락한 사람을 보여 준다', async () => {
    const result: RedlightResult = {
      finished: [
        { id: friend.id, name: '친구', time: 9_000, rank: 1 },
        { id: 'c', name: '셋', time: 9_000, rank: 1 },
        { id: me.id, name: '나', time: 12_340, rank: 3 },
      ],
      out: [{ id: 'd', name: '넷' }],
      unfinished: [{ id: 'e', name: '다섯' }],
    };
    const shown = await mount(<RedlightRanking {...props(view({ phase: 'green', slot: null }))} result={result} />);
    mounted.push(shown);
    const rows = [...shown.container.querySelectorAll('.mg-game-scores li')];
    expect(rows.map((item) => item.textContent)).toEqual(['1위친구9.0초', '1위셋9.0초', '3위나12.3초', '다섯미도착', '넷탈락']);
    expect(rows.map((item) => item.getAttribute('aria-current'))).toEqual([null, null, 'true', null, null]);
  });

  it('준비에 받은 내 자리로 한 번 옮기고, 아직 옮길 수 없으면 될 때까지 다시 해 본다', async () => {
    vi.useFakeTimers();
    try {
      const teleport = vi.fn<(ground: Vec3) => boolean>().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
      function Arrive({ slot }: { slot: Vec3 | null }) {
        useArrive(slot, teleport);
        return null;
      }
      const shown = await mount(<Arrive slot={[1, 0, -0.5]} />);
      mounted.push(shown);
      expect(teleport).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(250));
      expect(teleport).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTime(250));
      expect(teleport).toHaveBeenCalledTimes(3);
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(teleport).toHaveBeenCalledTimes(3);
      expect(teleport).toHaveBeenLastCalledWith([1, 0, -0.5]);
      // The same place again (a new view of it) moves no one; no place, nothing; a new place, once more.
      await shown.rerender(<Arrive slot={[1, 0, -0.5]} />);
      await shown.rerender(<Arrive slot={null} />);
      expect(teleport).toHaveBeenCalledTimes(3);
      await shown.rerender(<Arrive slot={[2, 0, 0.5]} />);
      expect(teleport).toHaveBeenCalledTimes(4);
      expect(teleport).toHaveBeenLastCalledWith([2, 0, 0.5]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('방장의 배치는 섬의 빈 자리 둘을 잇는 트인 긴 직선이고, 출발선 양옆에 자리가 있다', () => {
    const building = createVillage();
    const spots = openSpots(building, unmeasured);
    const session = { kind: 'redlight' } as GameSession;
    const track = gameOf('redlight')!.layout({ building, spots: () => spots, position: null, session }) as Track;
    expect(gameOf('redlight')).toBe(redlight);
    expect(spots).toContainEqual(track.start);
    expect(spots).toContainEqual(track.finish);
    expect(length(track)).toBeGreaterThanOrEqual(SHORTEST);
    expect(length(track)).toBeLessThanOrEqual(LONGEST);
    expect(overOpenGround(spots, track.start, track.finish)).toBe(true);
    expect(roomAtStart(spots, track)).toBe(true);
    expect(wallsOf(building).length).toBeGreaterThan(0);
    // Longer than the village's main road (36 m), and away from the camera (north, toward -z).
    expect(length(track)).toBeGreaterThan(36);
    expect(track.finish[2]).toBeLessThan(track.start[2]);
  });

  it('막힌 직선보다 트인 직선을, 자리 없는 출발보다 자리 있는 출발을 고르고, 벽은 지나지 않는다', () => {
    // A 40 m row with a gap in the middle and a clear 24 m row: the clear one, though nothing is beside it.
    const gapped = row(0, 0, 40).filter(([x]) => x !== 20);
    expect(ends(findTrack([...gapped, ...row(40, 0, 24)]))).toEqual(ends({ start: [0, 0, 40], finish: [24, 0, 40] }));
    // A clear 32 m row alone, and a band three rows wide but 16 m long: the band, where the line of players fits.
    const band = [...row(40, 0, 16), ...row(44, 0, 16), ...row(48, 0, 16)];
    const spots = [...row(0, 0, 32), ...band];
    const roomy = findTrack(spots);
    expect(roomy.start[2]).toBeGreaterThanOrEqual(40);
    expect(roomy.finish[2]).toBeGreaterThanOrEqual(40);
    expect(roomAtStart(spots, roomy)).toBe(true);
    // A road three rows wide and 40 m long: corner to corner (40.8 m) leaves no room beside the start; 40.2 m does.
    const road = [...row(-4, 0, 40), ...row(0, 0, 40), ...row(4, 0, 40)];
    const open = findTrack(road);
    expect(length(open)).toBeCloseTo(Math.hypot(40, 4));
    expect(roomAtStart(road, open)).toBe(true);
    // A wall across it: no line through the wall.
    const wall: Segment = [18, -6, 18, 6];
    const walled = findTrack(road, { walls: [wall] });
    expect(length(walled)).toBeCloseTo(Math.hypot(20, 4));
    expect(walled.start[0] > 18 && walled.finish[0] > 18).toBe(true);
  });

  it('남북으로 놓인 길은 북쪽으로 달리고, 트인 곳이 없으면 가장 먼 둘을, 16 m 떨어진 곳도 없으면 시작하지 않는다', () => {
    const column = (x: number) => Array.from({ length: 6 }, (_, index) => [x, 0, index * 4] as Vec3);
    expect(findTrack(column(0))).toEqual({ start: [0, 0, 20], finish: [0, 0, 0] });
    const band = findTrack([...column(-4), ...column(0), ...column(4)]);
    expect(band.finish[2]).toBeLessThan(band.start[2]);
    // Nothing open between them: the farthest two, still northward.
    expect(findTrack([[0, 0, 0], [30, 0, 0], [0, 0, 12]])).toEqual({ start: [0, 0, 12], finish: [30, 0, 0] });
    expect(() => findTrack([[0, 0, 0], [10, 0, 0], [0, 0, 10]])).toThrow('달릴 만큼 넓은 곳이 없어요.');
  });
});
