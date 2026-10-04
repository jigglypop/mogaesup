import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ticket } = vi.hoisted(() => ({ ticket: vi.fn() }));
vi.mock('../../api/endpoints', () => ({ authApi: { realtimeTicket: ticket } }));

import type { RealtimeTicket, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { readServerMessage } from '../protocol';
import { useGameSession, type GameSessionApi, type GameSessionOptions } from '../useGameSession';

/** A WebSocket the test opens, feeds and drops by hand. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static made: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: unknown[] = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.readyState = FakeSocket.CLOSED;
    this.closedWith = code;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    act(() => this.onopen?.());
  }
  receive(message: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
  drop(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    act(() => this.onclose?.({ code }));
  }
}

const viewer: User = { id: 'viewer-a', username: 'a', displayName: '에이', role: 'user' };
const other: User = { id: 'viewer-b', username: 'b', displayName: '비', role: 'user' };
const pass = (value: string, owner = viewer): RealtimeTicket => ({ ticket: value, user: owner, expiresAt: 9999999999 });
const flush = () => act(async () => void (await Promise.resolve()));
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const lobby = (now = 5_000_000) => ({
  kind: 'treasure', phase: 'lobby', host: viewer.id, you: viewer.id, seq: 1, now,
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
    expect(api.session).toMatchObject({ kind: 'treasure', phase: 'lobby', players: [{ name: '에이', peer: 'peer-1' }] });
    expect(Math.abs(api.serverNow() - (Date.now() + 60_000))).toBeLessThan(50);

    expect(api.open('treasure')).toBe(true);
    expect(api.start({ spots: [[0, 0, 0]] })).toBe(true);
    expect(api.act({ dig: true })).toBe(true);
    expect(api.leave()).toBe(true);
    expect(api.close()).toBe(true);
    expect(latest().sent).toEqual([
      { type: 'Open', kind: 'treasure' },
      { type: 'Start', layout: { spots: [[0, 0, 0]] } },
      { type: 'Act', action: { dig: true } },
      { type: 'Leave' },
      { type: 'Close' },
    ]);

    const heard = vi.fn();
    const stop = api.onEvent(heard);
    latest().receive({ type: 'Event', kind: 'treasure', event: { type: 'collected', value: 3 } });
    expect(heard).toHaveBeenCalledWith({ kind: 'treasure', event: { type: 'collected', value: 3 } });
    stop();
    latest().receive({ type: 'Event', kind: 'treasure', event: {} });
    expect(heard).toHaveBeenCalledTimes(1);

    latest().receive({ type: 'Error', code: 'not_host', message: '방장만 할 수 있어요.' });
    expect(api.error).toEqual({ code: 'not_host', message: '방장만 할 수 있어요.' });
    act(() => void api.join());
    expect(api.error).toBeNull();

    // Frames it does not know change nothing.
    const before = api.session;
    latest().receive({ type: 'Session', session: { kind: 'treasure' } });
    latest().receive({ type: 'Whatever' });
    expect(api.session).toBe(before);

    const socket = latest();
    await view.unmount();
    expect(socket.closedWith).toBe(1000);
    await wait(60_000);
    expect(FakeSocket.made).toHaveLength(1);
    expect(ticket).toHaveBeenCalledTimes(1);
  });

  it('끊기면 세션을 비우고 새 티켓으로 다시 연결하며, 세션을 받지 못한 시도마다 더 오래 기다린다', async () => {
    const view = await mount(<Probe {...options()} />);
    await flush();
    latest().open();
    latest().receive({ type: 'Session', session: lobby() });
    latest().drop();
    expect(api.session).toBeNull();
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
    // A session again: the wait starts over.
    latest().open();
    latest().receive({ type: 'Session', session: null });
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

  it('꺼져 있거나 로그인하지 않았거나 다른 계정의 티켓이면 소켓을 열지 않고, 꺼지면 닫는다', async () => {
    const off = await mount(<Probe {...options({ enabled: false })} />);
    await flush();
    await off.rerender(<Probe {...options({ enabled: false, viewerId: null })} />);
    await flush();
    expect(ticket).not.toHaveBeenCalled();
    await off.unmount();

    ticket.mockResolvedValueOnce(pass('theirs', other));
    const switched = await mount(<Probe {...options()} />);
    await flush();
    expect(FakeSocket.made).toHaveLength(0);
    await switched.unmount();

    const live = await mount(<Probe {...options()} />);
    await flush();
    latest().open();
    latest().receive({ type: 'Session', session: lobby() });
    await live.rerender(<Probe {...options({ enabled: false })} />);
    expect(latest().closedWith).toBe(1000);
    expect(api.session).toBeNull();
    await live.unmount();
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
});
