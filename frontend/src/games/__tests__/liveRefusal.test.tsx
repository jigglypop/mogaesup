import { act } from 'react';
import type { RapierRigidBody } from '@react-three/rapier';
import type { Group } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { multiplayer, ticket } = vi.hoisted(() => ({ multiplayer: vi.fn(), ticket: vi.fn() }));
vi.mock('gaesup-world', async (original) => ({
  ...(await original<typeof import('gaesup-world')>()),
  useMultiplayer: multiplayer,
  RemotePlayers: () => null,
  SpeechBalloon: () => null,
}));
vi.mock('../../api/endpoints', () => ({ authApi: { realtimeTicket: ticket } }));

import { MemoryRouter } from 'react-router-dom';

import type { RealtimeTicket, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { ChatBar, LiveRoom } from '../../minihome/live';
import { NO_SEAT } from '../useGameSession';

const viewer: User = { id: 'viewer-a', username: 'a', displayName: '방문자 A', role: 'user' };
const pass = (value: string): RealtimeTicket => ({ ticket: value, user: viewer, expiresAt: 9999999999 });
const flush = () => act(async () => void (await Promise.resolve()));
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

/** The engine's socket, as far as the page sees it: made in `connect`, and closed by the server with a code. */
class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static made: FakeSocket[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.made.push(this);
  }
  closeWith(code: number, reason: string) {
    act(() => void this.dispatchEvent(Object.assign(new Event('close'), { code, reason })));
  }
}

describe('실시간 방에 자리가 없을 때', () => {
  let live: { connectionStatus: string; isConnected: boolean; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; updateConfig: ReturnType<typeof vi.fn>; players: Map<string, unknown>; speechByPlayerId: Map<string, string> };
  const room = () => (
    <MemoryRouter>
      <LiveRoom username="host" viewer={viewer} characterUrl="/models/a.glb" playerRef={{ current: null! as RapierRigidBody }} visualRotationRef={{ current: null! as Group }}>
        <ChatBar signedIn />
      </LiveRoom>
    </MemoryRouter>
  );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeSocket.made = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    // The engine makes its socket inside connect(), as gaesup-world's does.
    live = {
      connectionStatus: 'disconnected',
      isConnected: false,
      connect: vi.fn(() => void new WebSocket('ws://test.local/api/rooms/host')),
      disconnect: vi.fn(),
      updateConfig: vi.fn(),
      players: new Map(),
      speechByPlayerId: new Map(),
    };
    multiplayer.mockImplementation(() => ({ ...live }));
    ticket.mockImplementation(async () => pass(`ticket-${ticket.mock.calls.length}`));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('닫힌 까닭을 함께 있는 사람 자리에 보이고, 다시 연결하기 전에 한참 기다리며, 들어가면 지운다', async () => {
    const view = await mount(room());
    await flush();
    expect(live.connect).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain('함께 있는 사람을 찾는 중…');
    expect(FakeSocket.made).toHaveLength(1);
    // The global the engine builds its socket with is the page's own again.
    expect(globalThis.WebSocket).toBe(FakeSocket);
    FakeSocket.made[0]!.closeWith(NO_SEAT, '같은 곳에서 열린 실시간 연결이 너무 많습니다.');
    await view.rerender(room());
    expect(view.container.querySelector('[role="status"]')!.textContent).toBe('같은 곳에서 열린 실시간 연결이 너무 많습니다.');
    // Each try takes a ticket: not again for half a minute.
    await wait(29_000);
    expect(ticket).toHaveBeenCalledTimes(1);
    await wait(2_000);
    expect(ticket).toHaveBeenCalledTimes(2);
    expect(live.connect).toHaveBeenCalledTimes(2);
    // Seated: the chat bar is back.
    Object.assign(live, { connectionStatus: 'connected', isConnected: true });
    await view.rerender(room());
    await wait(1_000);
    await view.rerender(room());
    expect(view.container.querySelector('input[aria-label="말하기"]')).not.toBeNull();
    // Closed for anything else, it says nothing of seats.
    Object.assign(live, { connectionStatus: 'disconnected', isConnected: false });
    FakeSocket.made[1]!.closeWith(4408, 'too slow');
    await view.rerender(room());
    expect(view.container.querySelector('[role="status"]')!.textContent).toBe('함께 있는 사람을 찾는 중…');
    await view.unmount();
  });
});
