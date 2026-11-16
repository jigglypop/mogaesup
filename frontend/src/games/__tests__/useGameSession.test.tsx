import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ticket } = vi.hoisted(() => ({ ticket: vi.fn() }));
vi.mock('../../api/endpoints', () => ({ authApi: { realtimeTicket: ticket } }));

import type { RealtimeTicket, User } from '../../api/types';
import { onSessionDoubt } from '../../auth/sessionWork';
import { mount } from '../../__tests__/mount';
import { readServerMessage } from '../protocol';
import { createServerClock } from '../time';
import { NO_SEAT, noSeat, useGameSession, type GameSessionApi, type GameSessionOptions } from '../useGameSession';
import { FakeSocket } from './socket';

const viewer: User = { id: 'viewer-a', username: 'a', displayName: '에이', role: 'user' };
const other: User = { id: 'viewer-b', username: 'b', displayName: '비', role: 'user' };
const pass = (value: string, owner = viewer): RealtimeTicket => ({ ticket: value, user: owner, expiresAt: 9999999999 });
const flush = () => act(async () => void (await Promise.resolve()));
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const lobby = (now = 5_000_000) => ({
  kind: 'impostor', phase: 'lobby', host: viewer.id, you: viewer.id, seq: 1, now,
  players: [{ id: viewer.id, name: '에이', peer: 'peer-1' }], game: null, result: null,
});

let api: GameSessionApi;
function Probe(props: GameSessionOptions) {
  api = useGameSession(props);
  return null;
}
const options = (changes: Partial<GameSessionOptions> = {}): GameSessionOptions =>
  ({ username: 'host', viewerId: viewer.id, peer: 'peer-1', enabled: true, ...changes });
const latest = () => FakeSocket.made.at(-1)!;

describe('섬의 게임 소켓', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeSocket.made = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    ticket.mockImplementation(async () => pass(`ticket-${ticket.mock.calls.length}`));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('티켓과 실시간 방의 내 peer로 연결하고 서버가 보낸 세션·이벤트·거절을 상태로 낸다', async () => {
    const view = await mount(<Probe {...options()} />);
    await flush();
    expect(FakeSocket.made).toHaveLength(1);
    expect(latest().url).toBe(`ws://${location.host}/api/games/host?ticket=ticket-1&peer=peer-1`);
    expect(api.connected).toBe(false);
    expect(api.join()).toBe(false);
    latest().open();
    expect(api.connected).toBe(true);
    latest().receive({ type: 'Session', session: lobby(Date.now() + 60_000) });
    expect(api.session).toMatchObject({ kind: 'impostor', phase: 'lobby', players: [{ name: '에이', peer: 'peer-1' }] });
    expect(Math.abs(api.serverNow() - (Date.now() + 60_000))).toBeLessThan(50);

    expect(api.open('impostor')).toBe(true);
    expect(api.start({ spots: [[0, 0, 0]] })).toBe(true);
    expect(api.act({ dig: true })).toBe(true);
    expect(api.leave()).toBe(true);
    expect(api.close()).toBe(true);
    expect(latest().sent).toEqual([
      { type: 'Open', kind: 'impostor' },
      { type: 'Start', layout: { spots: [[0, 0, 0]] } },
      { type: 'Act', action: { dig: true } },
      { type: 'Leave' },
      { type: 'Close' },
    ]);

    const heard = vi.fn();
    const stop = api.onEvent(heard);
    latest().receive({ type: 'Event', kind: 'impostor', event: { type: 'killed', value: 3 } });
    expect(heard).toHaveBeenCalledWith({ kind: 'impostor', event: { type: 'killed', value: 3 } });
    stop();
    latest().receive({ type: 'Event', kind: 'impostor', event: {} });
    expect(heard).toHaveBeenCalledTimes(1);

    latest().receive({ type: 'Error', code: 'not_host', message: '방장만 할 수 있어요.' });
    expect(api.error).toEqual({ code: 'not_host', message: '방장만 할 수 있어요.' });
    act(() => void api.join());
    expect(api.error).toBeNull();

    // Frames it does not know change nothing.
    const before = api.session;
    latest().receive({ type: 'Session', session: { kind: 'impostor' } });
    latest().receive({ type: 'Whatever' });
    expect(api.session).toBe(before);

    const socket = latest();
    await view.unmount();
    expect(socket.closedWith).toBe(1000);
    await wait(60_000);
    expect(FakeSocket.made).toHaveLength(1);
    expect(ticket).toHaveBeenCalledTimes(1);
  });

  it('끊겨도 세션은 다음 소켓이 말할 때까지 그대로 두고, 새 티켓으로 다시 연결하며, 세션을 받지 못한 시도마다 더 오래 기다린다', async () => {
    const view = await mount(<Probe {...options()} />);
    await flush();
    latest().open();
    latest().receive({ type: 'Session', session: lobby() });
    const shown = api.session;
    latest().drop();
    // The game goes on without the socket: what it showed stays.
    expect(api.session).toBe(shown);
    expect(api.connected).toBe(false);
    // Had a session: back after a second, with a fresh ticket.
    await wait(999);
    expect(FakeSocket.made).toHaveLength(1);
    await wait(1);
    expect(FakeSocket.made).toHaveLength(2);
    expect(latest().url).toContain('ticket=ticket-2');
    // Refused at once (no session): two seconds, then four.
    latest().drop();
    await wait(1_999);
    expect(FakeSocket.made).toHaveLength(2);
    await wait(1);
    expect(FakeSocket.made).toHaveLength(3);
    latest().drop();
    await wait(3_999);
    expect(FakeSocket.made).toHaveLength(3);
    await wait(1);
    expect(FakeSocket.made).toHaveLength(4);
    expect(api.session).toBe(shown);
    // A session again: the wait starts over. The new socket's word is what the session is now.
    latest().open();
    latest().receive({ type: 'Session', session: null });
    expect(api.session).toBeNull();
    latest().drop();
    await wait(1_000);
    expect(FakeSocket.made).toHaveLength(5);
    // A try whose ticket request fails waits longer again.
    ticket.mockRejectedValueOnce(new Error('rate limited'));
    latest().drop();
    await wait(2_000);
    expect(ticket).toHaveBeenCalledTimes(6);
    expect(FakeSocket.made).toHaveLength(5);
    await wait(3_999);
    expect(FakeSocket.made).toHaveLength(5);
    await wait(1);
    expect(FakeSocket.made).toHaveLength(6);
    await view.unmount();
  });

  it('자리가 없어 닫히면 그 까닭을 보이고 한참 뒤에 다시 연결한다', async () => {
    const view = await mount(<Probe {...options()} />);
    await flush();
    latest().open();
    latest().drop(NO_SEAT, '같은 곳에서 열린 게임 연결이 너무 많아요.');
    expect(api.error).toEqual({ code: 'no_seat', message: '같은 곳에서 열린 게임 연결이 너무 많아요.' });
    expect(api.connected).toBe(false);
    // Each try takes a ticket: not again for half a minute.
    await wait(29_999);
    expect(FakeSocket.made).toHaveLength(1);
    await wait(1);
    expect(FakeSocket.made).toHaveLength(2);
    expect(ticket).toHaveBeenCalledTimes(2);
    // Seated this time: the reason goes with the next message.
    latest().open();
    latest().receive({ type: 'Session', session: lobby() });
    expect(api.error).not.toBeNull();
    act(() => void api.join());
    expect(api.error).toBeNull();
    // Closed for anything else: no reason to show.
    latest().drop(1006);
    expect(api.error).toBeNull();
    expect(noSeat({ code: NO_SEAT })).toBe('지금은 들어갈 자리가 없어요.');
    expect(noSeat({ code: 4408, reason: 'too slow' })).toBeNull();
    await view.unmount();
  });

  it('세션을 받기 전까지는 세션이 없다고 하지 않고, 게임이 데려간 자리는 소켓이 바뀌어도 기억한다', async () => {
    const view = await mount(<Probe {...options()} />);
    await flush();
    latest().open();
    expect([api.connected, api.synced]).toEqual([true, false]);
    latest().receive({ type: 'Session', session: null });
    expect(api.synced).toBe(true);
    api.client.setTrip({ key: '3:100', home: [1, 2, 3] });
    latest().drop();
    expect([api.connected, api.synced]).toEqual([false, false]);
    await wait(1_000);
    latest().open();
    expect(api.synced).toBe(false);
    expect(api.client.trip()).toEqual({ key: '3:100', home: [1, 2, 3] });
    await view.unmount();
  });

  it('세션마다 조금씩 늦게 오는 서버 시각에 시계가 튀지 않는다', async () => {
    const view = await mount(<Probe {...options()} />);
    await flush();
    latest().open();
    const ahead = 60_000;
    latest().receive({ type: 'Session', session: lobby(Date.now() + ahead) });
    const before = api.serverNow() - Date.now();
    // Frames that took longer to come do not pull the clock back.
    for (const late of [40, 120, 15, 300]) latest().receive({ type: 'Session', session: lobby(Date.now() + ahead - late) });
    expect(api.serverNow() - Date.now()).toBe(before);
    await view.unmount();
  });

  it('서버가 이 사람에게 소켓을 닫으면(로그인 끝 4401, 섬 닫힘 4403) 세션을 비운다', async () => {
    const view = await mount(<Probe {...options()} />);
    await flush();
    for (const code of [4401, 4403]) {
      latest().open();
      latest().receive({ type: 'Session', session: lobby() });
      expect(api.session).not.toBeNull();
      latest().drop(code);
      expect(api.session).toBeNull();
      expect(api.connected).toBe(false);
      await wait(1_000);
    }
    expect(FakeSocket.made).toHaveLength(3);
    await view.unmount();
  });

  it('꺼져 있거나 로그인하지 않았거나 다른 계정의 티켓이면 소켓을 열지 않고, 꺼지면 닫되 세션은 바로 비우지 않으며, 섬이나 계정이 바뀌면 비운다', async () => {
    const off = await mount(<Probe {...options({ enabled: false })} />);
    await flush();
    await off.rerender(<Probe {...options({ enabled: false, viewerId: null })} />);
    await flush();
    expect(ticket).not.toHaveBeenCalled();
    await off.unmount();

    const doubted = vi.fn();
    const stopDoubt = onSessionDoubt(doubted);
    ticket.mockResolvedValueOnce(pass('theirs', other));
    const switched = await mount(<Probe {...options()} />);
    await flush();
    expect(FakeSocket.made).toHaveLength(0);
    // The session cookie is someone else's: the app is asked who is signed in.
    expect(doubted).toHaveBeenCalledTimes(1);
    await switched.unmount();
    stopDoubt();

    const live = await mount(<Probe {...options()} />);
    await flush();
    latest().open();
    latest().receive({ type: 'Session', session: lobby() });
    const shown = api.session;
    // Out of the live room while it connects again: the socket closes, the session stays as last shown.
    await live.rerender(<Probe {...options({ enabled: false })} />);
    expect(latest().closedWith).toBe(1000);
    expect(api.session).toBe(shown);
    expect(api.connected).toBe(false);
    await live.rerender(<Probe {...options()} />);
    await flush();
    expect(FakeSocket.made).toHaveLength(2);
    expect(api.session).toBe(shown);
    // Another island, or another account, starts with none.
    await live.rerender(<Probe {...options({ username: 'other' })} />);
    expect(FakeSocket.made[1]!.closedWith).toBe(1000);
    expect(api.session).toBeNull();
    await flush();
    latest().open();
    latest().receive({ type: 'Session', session: lobby() });
    await live.rerender(<Probe {...options({ username: 'other', viewerId: other.id, enabled: false })} />);
    expect(api.session).toBeNull();
    await live.unmount();
  });

  it('꺼진 채 실시간 방이 돌아오지 않으면 서버가 게임에서 뺄 무렵 세션도 비운다', async () => {
    const view = await mount(<Probe {...options()} />);
    await flush();
    latest().open();
    latest().receive({ type: 'Session', session: lobby() });
    const shown = api.session;
    // The live room comes back in time: the session goes on as shown.
    await view.rerender(<Probe {...options({ enabled: false })} />);
    await wait(14_999);
    expect(api.session).toBe(shown);
    await view.rerender(<Probe {...options()} />);
    await flush();
    await wait(15_000);
    expect(api.session).toBe(shown);
    // Shut out of the live room, its game socket closed before the server's own word came: it goes in the end.
    await view.rerender(<Probe {...options({ enabled: false })} />);
    await wait(14_999);
    expect(api.session).toBe(shown);
    await wait(1);
    expect(api.session).toBeNull();
    expect(FakeSocket.made).toHaveLength(2);
    await view.unmount();
  });
});

describe('게임 소켓 메시지 읽기', () => {
  it('아는 모양만 받아들인다', () => {
    expect(readServerMessage(JSON.stringify({ type: 'Session', session: null }))).toEqual({ type: 'Session', session: null });
    expect(readServerMessage(JSON.stringify({ type: 'Session', session: lobby() }))).toMatchObject({ type: 'Session', session: { phase: 'lobby' } });
    expect(readServerMessage(JSON.stringify({ type: 'Session', session: { ...lobby(), phase: 'paused' } }))).toBeNull();
    expect(readServerMessage(JSON.stringify({ type: 'Session', session: { ...lobby(), players: [{ id: 1 }] } }))).toBeNull();
    expect(readServerMessage(JSON.stringify({ type: 'Error', code: 'x' }))).toBeNull();
    expect(readServerMessage(JSON.stringify({ type: 'Pong', ts: 4 }))).toEqual({ type: 'Pong', ts: 4 });
    expect(readServerMessage('{')).toBeNull();
    expect(readServerMessage(new ArrayBuffer(2))).toBeNull();
  });

  it('구경하는 자리와 돌아갈 자리는 세 수일 때만 읽고, 없거나 서버가 말하지 않으면 null이다', () => {
    const read = (session: object) => (readServerMessage(JSON.stringify({ type: 'Session', session })) as { session: { home: unknown; stand: unknown } }).session;
    expect(read({ ...lobby(), home: [1, 0, 2], stand: [0, 0, -8] })).toMatchObject({ home: [1, 0, 2], stand: [0, 0, -8] });
    expect(read(lobby())).toMatchObject({ home: null, stand: null });
    expect(read({ ...lobby(), stand: [0, 'x', 1] })).toMatchObject({ stand: null });
  });
});

describe('서버 시계', () => {
  it('가장 빨리 온 표본을 쓰고, 조금씩 따라가며, 크게 어긋나면 한 번에 맞춘다', () => {
    let local = 1_000_000;
    const clock = createServerClock(() => local);
    expect(clock.now()).toBe(local);
    clock.sample(local + 5_000);
    expect(clock.now()).toBe(local + 5_000);
    // One that came 80 ms late changes nothing.
    local += 100;
    clock.sample(local + 5_000 - 80);
    expect(clock.now()).toBe(local + 5_000);
    // One that came quicker is followed, 5 % of the time since at most.
    local += 100;
    clock.sample(local + 5_030);
    expect(clock.now()).toBe(local + 5_005);
    local += 1_000;
    clock.sample(local + 5_030);
    expect(clock.now()).toBe(local + 5_030);
    // The computer's clock set seconds off: taken at once; and old samples count only ten seconds.
    local -= 4_000;
    clock.sample(local + 9_030);
    expect(clock.now()).toBe(local + 9_030);
    local += 15_000;
    clock.sample(local + 2_000);
    expect(clock.now()).toBe(local + 2_000);
  });
});
