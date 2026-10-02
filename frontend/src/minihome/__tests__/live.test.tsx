import { act } from 'react';
import type { RapierRigidBody } from '@react-three/rapier';
import type { Group } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { multiplayer, avatars, ticket } = vi.hoisted(() => ({
  multiplayer: vi.fn(), avatars: vi.fn(() => null), ticket: vi.fn(),
}));
vi.mock('gaesup-world', async (original) => ({
  ...await original<typeof import('gaesup-world')>(),
  useMultiplayer: multiplayer,
  RemotePlayers: avatars,
}));
vi.mock('../../api/endpoints', () => ({ authApi: { realtimeTicket: ticket } }));

import type { RealtimeTicket, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { LiveAvatars, LiveRoom } from '../live';

const user: User = { id: 'viewer-a', username: 'a', displayName: '방문자 A', role: 'user' };
const other: User = { id: 'viewer-b', username: 'b', displayName: '방문자 B', role: 'user' };
const pass = (value: string, owner = user): RealtimeTicket => ({ ticket: value, user: owner, expiresAt: 9999999999 });
const flush = () => act(async () => void await Promise.resolve());

describe('방문자 연결과 캐릭터 전달', () => {
  let live: {
    connectionStatus: string;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    updateConfig: ReturnType<typeof vi.fn>;
    players: Map<string, unknown>;
    speechByPlayerId: Map<string, string>;
  };
  const body = { current: null! as RapierRigidBody };
  const visual = { current: null! as Group };
  const room = (viewer: User | null = user) => <LiveRoom username="host" viewer={viewer}
    characterUrl="/models/assembled.glb" playerRef={body} visualRotationRef={visual}>
    <LiveAvatars playerRef={body} />
  </LiveRoom>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    live = { connectionStatus: 'disconnected', connect: vi.fn(), disconnect: vi.fn(), updateConfig: vi.fn(),
      players: new Map(), speechByPlayerId: new Map() };
    multiplayer.mockReturnValue(live);
    ticket.mockResolvedValue(pass('one-use'));
  });
  afterEach(() => vi.useRealTimers());

  it('자기 모델 URL과 실제 시각 회전을 추적하고 원격 모델의 원래 색을 보존한다', async () => {
    const view = await mount(room());
    await flush();
    const options = multiplayer.mock.calls[0]![0];
    expect(options.characterUrl).toBe(new URL('/models/assembled.glb', location.origin).href);
    expect(options.rigidBodyRef).toBe(body);
    expect(options.visualRotationRef).toBe(visual);
    const rendered = avatars.mock.calls[0] as unknown as [{ config: unknown; players: unknown }];
    expect(rendered[0].config).toBe(options.config);
    expect(rendered[0].players).toBe(live.players);
    expect(options.config.rendering).toMatchObject({ materialPolicy: 'figure', tintCharacter: false, characterScale: 1.5 });
    expect(live.connect).toHaveBeenCalledWith({ roomId: 'host', playerName: user.displayName, playerColor: expect.stringMatching(/^#[0-9a-f]{6}$/) });
    await view.unmount();
    expect(live.disconnect).toHaveBeenCalledTimes(1);
  });

  it('연결을 다시 열 때 소비한 티켓 대신 새 티켓을 쓴다', async () => {
    ticket.mockResolvedValueOnce(pass('first')).mockResolvedValueOnce(pass('second'));
    const view = await mount(room());
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(ticket).toHaveBeenCalledTimes(2);
    expect(live.updateConfig.mock.calls[0]![0].websocket.url).toContain('ticket=first');
    expect(live.updateConfig.mock.calls[1]![0].websocket.url).toContain('ticket=second');
    await view.unmount();
  });

  it('계정이 바뀐 뒤 도착한 이전 계정 티켓으로 연결하지 않는다', async () => {
    let finish!: (result: RealtimeTicket) => void;
    ticket.mockReturnValueOnce(new Promise<RealtimeTicket>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(pass('b-pass', other));
    const view = await mount(room());
    await view.rerender(room(other));
    await flush();
    finish(pass('late-a'));
    await flush();
    expect(live.connect).toHaveBeenCalledTimes(1);
    expect(live.connect.mock.calls[0]![0].playerName).toBe(other.displayName);
    expect(live.updateConfig.mock.calls[0]![0].websocket.url).toContain('ticket=b-pass');
    await view.unmount();
  });

  it('티켓 발급 시 쿠키 계정이 이미 바뀌었다면 이전 이름으로 방에 들어가지 않는다', async () => {
    ticket.mockResolvedValue(pass('wrong-owner', other));
    const view = await mount(room());
    await flush();
    expect(live.connect).not.toHaveBeenCalled();
    expect(live.updateConfig).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('로그인하지 않은 방문자는 티켓을 발급하지 않는다', async () => {
    const view = await mount(room(null));
    await flush();
    expect(ticket).not.toHaveBeenCalled();
    await view.unmount();
  });
});
