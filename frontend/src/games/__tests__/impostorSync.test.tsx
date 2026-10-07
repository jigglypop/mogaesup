import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import type { GameProps, Trip } from '../game';
import { hiddenPeers } from '../hiddenPeers';
import type { ImpostorMeeting, ImpostorView } from '../impostor';
import { useImpostorSync } from '../impostor/sync';
import type { GameSession, SessionPlayer, Vec3 } from '../protocol';
import { roomQuiet } from '../quiet';

const players: SessionPlayer[] = [
  { id: 'me', name: '나', peer: 'peer-me' },
  { id: 'b', name: '비', peer: 'peer-b' },
  { id: 'c', name: '씨', peer: 'peer-c' },
];

const view = (changes: Partial<ImpostorView> = {}) =>
  ({ phase: 'play', role: 'crew', alive: true, spawn: null, venting: null, vents: [], meeting: null, ...changes }) as ImpostorView;

const meeting = (number: number, seat: Vec3 | null, voted = 0) => ({ number, seat, voted }) as ImpostorMeeting;

/** The page's trip, as the game client keeps it across sockets. */
function trips() {
  let trip: Trip | null = null;
  return { trip: () => trip, setTrip: (next: Trip | null) => void (trip = next) };
}

/** Where the viewer stands on the island before the game takes them to the ship. */
const HOME: Vec3 = [5, 1, 5];

/**
 * The viewer's body: where it stands, put wherever a teleport puts it; `anew` makes a new one at the island's start, as
 * a canvas set up again does.
 */
function body(start: Vec3 = HOME) {
  let at = start;
  let own = { made: 1 };
  const teleport = vi.fn((ground: Vec3) => {
    at = ground;
    return true;
  });
  return {
    teleport,
    position: () => at,
    body: () => own,
    put: (place: Vec3) => void (at = place),
    anew: (place: Vec3) => {
      own = { made: own.made + 1 };
      at = place;
    },
  };
}

type Given = {
  view: ImpostorView;
  teleport: (ground: Vec3) => boolean;
  position?: () => Vec3 | null;
  body?: () => object | null;
  store?: ReturnType<typeof trips>;
  startedAt?: number;
  home?: Vec3 | null;
  stand?: Vec3 | null;
  you?: string;
};

const here = () => HOME;
const nobody = () => null;
const fallback = trips();

function Sync({ view: shown, teleport, position = here, body: own = nobody, store = fallback, startedAt = 100, home = null, stand = null, you = 'me' }: Given) {
  const session = { id: 7, kind: 'impostor', players, you, startedAt, home, stand } as GameSession<ImpostorView>;
  useImpostorSync({ view: shown, session, teleport, position, body: own as GameProps['body'], ...store });
  return null;
}

/** The viewer's place by the table: the ship lies where the island does. */
const SHIP: Vec3 = [1.6, 0, 0];

describe('임포스터가 섬에서 하는 일', () => {
  afterEach(() => {
    fallback.setTrip(null);
    vi.useRealTimers();
  });

  it('시작하면 우주선의 탁자 둘레 제자리로 한 번 옮기고, 끝나면 섬의 원래 자리로 돌려보낸다', async () => {
    const viewer = body();
    const store = trips();
    const shown = await mount(<Sync view={view({ spawn: SHIP })} {...viewer} store={store} />);
    expect(viewer.teleport.mock.calls).toEqual([[SHIP]]);
    expect(store.trip()).toEqual({ key: '7:100', home: HOME, at: SHIP, to: SHIP.join(','), body: viewer.body() });
    await shown.rerender(<Sync view={view({ spawn: SHIP, alive: false })} {...viewer} store={store} />);
    expect(viewer.teleport).toHaveBeenCalledTimes(1);
    await shown.rerender(<Sync view={view({ phase: 'ended', spawn: SHIP })} {...viewer} store={store} />);
    expect(viewer.teleport.mock.calls.at(-1)).toEqual([HOME]);
    expect(store.trip()).toBeNull();
    await shown.unmount();
    expect(viewer.teleport).toHaveBeenCalledTimes(2);
  });

  it('돌아갈 곳은 서버가 알려 준 자리다: 서버는 그 근처로만 돌려보낸다', async () => {
    const viewer = body();
    const store = trips();
    const told: Vec3 = [9, 1, 9];
    const shown = await mount(<Sync view={view({ spawn: SHIP })} {...viewer} store={store} home={told} />);
    expect(store.trip()).toMatchObject({ key: '7:100', home: told, at: SHIP });
    await shown.rerender(<Sync view={view({ phase: 'ended' })} {...viewer} store={store} home={told} />);
    expect(viewer.teleport.mock.calls.at(-1)).toEqual([told]);
    await shown.unmount();
  });

  it('게임 소켓이 끊겼다 붙어 화면이 다시 놓여도 섬에 갔다 오지 않고, 다음 판은 처음 자리를 기억한다', async () => {
    const viewer = body();
    const store = trips();
    const first = await mount(<Sync view={view({ spawn: SHIP })} {...viewer} store={store} />);
    // The socket drops: the World goes, and the viewer stays where they are, in the ship.
    viewer.put([12, 0.5, -3]);
    await first.unmount();
    expect(viewer.teleport.mock.calls).toEqual([[SHIP]]);
    const again = await mount(<Sync view={view({ spawn: SHIP })} {...viewer} store={store} />);
    expect(viewer.teleport).toHaveBeenCalledTimes(1);
    expect(store.trip()?.at).toEqual([12, 0.5, -3]);
    await again.unmount();
    // Another game before the trip home: to its start, and home is still where they stood first.
    const next = await mount(<Sync view={view({ spawn: [0, 0, 1.6] })} {...viewer} store={store} startedAt={900} />);
    expect(viewer.teleport.mock.calls.at(-1)).toEqual([[0, 0, 1.6]]);
    expect(store.trip()).toMatchObject({ key: '7:900', home: HOME, at: [0, 0, 1.6] });
    await next.rerender(<Sync view={view({ phase: 'ended' })} {...viewer} store={store} startedAt={900} />);
    expect(viewer.teleport.mock.calls.at(-1)).toEqual([HOME]);
    await next.unmount();
  });

  it('캔버스가 새로 놓여 몸이 새로 생기면 우주선에서 마지막에 서 있던 자리로 다시 옮긴다', async () => {
    vi.useFakeTimers();
    const viewer = body();
    const store = trips();
    const first = await mount(<Sync view={view({ spawn: SHIP })} {...viewer} store={store} />);
    // Walking about the ship: where they stand is kept a few times a second.
    viewer.put([12, 0.5, -3]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(store.trip()?.at).toEqual([12, 0.5, -3]);
    await first.unmount();
    // The canvas comes up anew: a new body at the island's start, which lies inside the ship now (nothing about where
    // it stands tells it apart). Put back where they were, home kept.
    viewer.anew(HOME);
    const again = await mount(<Sync view={view({ spawn: SHIP })} {...viewer} store={store} />);
    expect(viewer.teleport.mock.calls).toEqual([[SHIP], [[12, 0.5, -3]]]);
    expect(store.trip()).toMatchObject({ key: '7:100', home: HOME, at: [12, 0.5, -3], body: viewer.body() });
    // The same body after that: left where it walks.
    viewer.put([14, 0.5, -3]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(viewer.teleport).toHaveBeenCalledTimes(2);
    // A new body made while the World is mounted: found at the next look, a quarter of a second on.
    viewer.anew(HOME);
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(viewer.teleport.mock.calls.at(-1)).toEqual([[14, 0.5, -3]]);
    await again.unmount();
  });

  it('맵 밖으로 떨어지면 마지막에 서 있던 자리로 돌아간다', async () => {
    vi.useFakeTimers();
    const viewer = body();
    const store = trips();
    const shown = await mount(<Sync view={view({ spawn: SHIP })} {...viewer} store={store} />);
    viewer.put([20, 0.5, 4]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    viewer.put([60, -25, 4]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(viewer.teleport.mock.calls.at(-1)).toEqual([[20, 0.5, 4]]);
    expect(store.trip()?.at).toEqual([20, 0.5, 4]);
    await shown.unmount();
  });

  it('구경하는 사람은 서버가 정한 자리 둘레에 서고, 게임을 나간 사람도 그리로 옮긴다', async () => {
    const stand: Vec3 = [0, 0, -8];
    const watcher = body();
    const store = trips();
    const watching = view({ role: null, alive: null });
    const shown = await mount(<Sync view={watching} {...watcher} store={store} home={HOME} stand={stand} you="watcher" />);
    const [spot] = watcher.teleport.mock.calls.at(-1)!;
    expect(spot[1]).toBe(0);
    expect(Math.hypot(spot[0] - stand[0], spot[2] - stand[2])).toBeLessThanOrEqual(1.5);
    expect(store.trip()).toMatchObject({ home: HOME, at: spot });
    await shown.rerender(<Sync view={{ ...watching, phase: 'ended' }} {...watcher} store={store} home={HOME} you="watcher" />);
    expect(watcher.teleport.mock.calls.at(-1)).toEqual([HOME]);
    await shown.unmount();
    // Someone else stands elsewhere round it, so watchers do not stand inside one another.
    const other = body();
    const theirs = await mount(<Sync view={watching} {...other} store={trips()} home={HOME} stand={stand} you="someone" />);
    expect(other.teleport.mock.calls[0]![0]).not.toEqual(spot);
    await theirs.unmount();
    // A player who leaves while it plays: from their place on the ship to the stand, still going home at the end.
    const player = body();
    const mine = trips();
    const playing = await mount(<Sync view={view({ spawn: SHIP })} {...player} store={mine} home={HOME} />);
    await playing.rerender(<Sync view={view({ spawn: null, role: null, alive: null })} {...player} store={mine} home={HOME} stand={stand} />);
    expect(player.teleport).toHaveBeenCalledTimes(2);
    expect(mine.trip()).toMatchObject({ home: HOME, to: player.teleport.mock.calls[1]![0].join(',') });
    await playing.unmount();
  });

  it('옮길 몸이 아직 없으면 다녀온 것으로 치지 않는다', async () => {
    const teleport = vi.fn((_ground: Vec3) => false);
    const store = trips();
    const shown = await mount(<Sync view={view({ spawn: SHIP })} teleport={teleport} store={store} />);
    expect(store.trip()).toBeNull();
    await shown.unmount();
  });

  it('방이 직접 숨기기 전의 서버가 숨기라고 한 사람은 섬에서 그리지 않는다', async () => {
    const teleport = vi.fn((_ground: Vec3) => true);
    // Today's server names nobody: nobody is left out.
    const shown = await mount(<Sync view={view({ hidden: [] })} teleport={teleport} />);
    expect([...hiddenPeers.get()]).toEqual([]);
    // One from before names the dead and those in vents (the viewer among them, if so, is still drawn as themselves).
    await shown.rerender(<Sync view={view({ hidden: ['b', 'me'] })} teleport={teleport} />);
    expect([...hiddenPeers.get()]).toEqual(['peer-b']);
    // Once it is over, everyone again.
    await shown.rerender(<Sync view={view({ phase: 'ended', hidden: ['b'] })} teleport={teleport} />);
    expect([...hiddenPeers.get()]).toEqual([]);
    await shown.rerender(<Sync view={view({ hidden: ['c'] })} teleport={teleport} />);
    await shown.unmount();
    expect([...hiddenPeers.get()]).toEqual([]);
  });


  it('회의 밖에서는 참가한 사람이 섬 채팅을 쓰지 않고, 회의나 끝, 구경하는 사람은 그대로 쓴다', async () => {
    const teleport = vi.fn(() => true);
    const shown = await mount(<Sync view={view()} teleport={teleport} />);
    expect(roomQuiet.get()).toBe(true);
    await shown.rerender(<Sync view={view({ phase: 'discuss', meeting: meeting(1, null) })} teleport={teleport} />);
    expect(roomQuiet.get()).toBe(false);
    await shown.rerender(<Sync view={view({ alive: false })} teleport={teleport} />);
    expect(roomQuiet.get()).toBe(true);
    await shown.rerender(<Sync view={view({ phase: 'ended' })} teleport={teleport} />);
    expect(roomQuiet.get()).toBe(false);
    await shown.rerender(<Sync view={view({ role: null })} teleport={teleport} />);
    expect(roomQuiet.get()).toBe(false);
    await shown.rerender(<Sync view={view()} teleport={teleport} />);
    await shown.unmount();
    expect(roomQuiet.get()).toBe(false);
  });

  it('환풍구를 옮겨 갈 때마다 그 환풍구로 옮긴다', async () => {
    const teleport = vi.fn((_ground: Vec3) => true);
    const vents: Vec3[] = [[0, 0, 20], [20, 0, 20]];
    const shown = await mount(<Sync view={view({ vents })} teleport={teleport} />);
    expect(teleport).not.toHaveBeenCalled();
    // Into a vent where they stand: taken to it; on to the next; out and in again.
    await shown.rerender(<Sync view={view({ vents, venting: 0 })} teleport={teleport} />);
    expect(teleport.mock.calls.at(-1)).toEqual([[0, 0, 20]]);
    await shown.rerender(<Sync view={view({ vents, venting: 1 })} teleport={teleport} />);
    expect(teleport.mock.calls.at(-1)).toEqual([[20, 0, 20]]);
    await shown.rerender(<Sync view={view({ vents, venting: 1 })} teleport={teleport} />);
    expect(teleport).toHaveBeenCalledTimes(2);
    await shown.rerender(<Sync view={view({ vents, venting: null })} teleport={teleport} />);
    await shown.rerender(<Sync view={view({ vents, venting: 1 })} teleport={teleport} />);
    expect(teleport).toHaveBeenCalledTimes(3);
    await shown.unmount();
  });

  it('회의가 시작되면 살아 있는 사람을 자기 자리로 한 번 옮긴다', async () => {
    const teleport = vi.fn((_ground: Vec3) => true);
    const shown = await mount(<Sync view={view({ phase: 'discuss', meeting: meeting(1, [1.6, 0, 0]) })} teleport={teleport} />);
    expect(teleport.mock.calls).toEqual([[[1.6, 0, 0]]]);
    // The same meeting, updated: no second move.
    await shown.rerender(<Sync view={view({ phase: 'vote', meeting: meeting(1, [1.6, 0, 0], 2) })} teleport={teleport} />);
    await shown.rerender(<Sync view={view()} teleport={teleport} />);
    expect(teleport).toHaveBeenCalledTimes(1);
    await shown.rerender(<Sync view={view({ phase: 'discuss', meeting: meeting(2, [0, 0, 1.6]) })} teleport={teleport} />);
    expect(teleport.mock.calls.at(-1)).toEqual([[0, 0, 1.6]]);
    // The dead have no seat.
    await shown.rerender(<Sync view={view({ phase: 'discuss', alive: false, meeting: meeting(3, null) })} teleport={teleport} />);
    expect(teleport).toHaveBeenCalledTimes(2);
    await shown.unmount();
  });

  it('아직 옮길 몸이 없으면 다음 화면에서 다시 옮긴다', async () => {
    const teleport = vi.fn((_ground: Vec3) => false);
    const shown = await mount(<Sync view={view({ phase: 'discuss', meeting: meeting(1, [1.6, 0, 0]) })} teleport={teleport} />);
    teleport.mockReturnValue(true);
    await shown.rerender(<Sync view={view({ phase: 'discuss', meeting: meeting(1, [1.6, 0, 0], 1) })} teleport={teleport} />);
    await shown.rerender(<Sync view={view({ phase: 'discuss', meeting: meeting(1, [1.6, 0, 0], 2) })} teleport={teleport} />);
    expect(teleport).toHaveBeenCalledTimes(2);
    await shown.unmount();
  });
});
