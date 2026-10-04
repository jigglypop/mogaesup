import { act, useState } from 'react';
import type { RapierRigidBody } from '@react-three/rapier';
import type { Group } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { multiplayer, avatars, balloon, frame, ticket } = vi.hoisted(() => ({
  multiplayer: vi.fn(), avatars: vi.fn(() => null), balloon: vi.fn(() => null), frame: vi.fn(), ticket: vi.fn(),
}));
vi.mock('gaesup-world', async (original) => ({
  ...await original<typeof import('gaesup-world')>(),
  useMultiplayer: multiplayer,
  RemotePlayers: avatars,
  SpeechBalloon: balloon,
}));
vi.mock('@react-three/fiber', async (original) => ({
  ...await original<typeof import('@react-three/fiber')>(),
  useFrame: frame,
}));
vi.mock('../../api/endpoints', () => ({ authApi: { realtimeTicket: ticket } }));

import { MemoryRouter } from 'react-router-dom';

import type { RealtimeTicket, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { useUIConfigStore } from 'gaesup-world';

import { ChatBar, LiveAvatars, LiveRoom } from '../live';

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

  it('내가 한 말은 내 캐릭터 위 말풍선으로 몸을 따라간다', async () => {
    const view = await mount(room());
    await flush();
    expect(balloon).not.toHaveBeenCalled();
    Object.assign(live, { localSpeechText: '안녕하세요' });
    multiplayer.mockReturnValue({ ...live });
    await view.rerender(room());
    const props = (balloon.mock.calls.at(-1) as unknown as [{ text: string; position: { x: number; y: number; z: number } }])[0];
    expect(props.text).toBe('안녕하세요');
    // Each frame copies the body's place into the vector the balloon follows.
    body.current = { translation: () => ({ x: 3, y: 1.5, z: -2 }) } as unknown as RapierRigidBody;
    (frame.mock.calls.at(-1) as unknown as [() => void])[0]();
    expect([props.position.x, props.position.y, props.position.z]).toEqual([3, 1.5, -2]);
    // Balloons (the others' too) sit just above the name tags, sized for the island camera.
    const balloons = useUIConfigStore.getState().config.speechBalloon;
    expect(balloons.defaultOffset.y).toBeCloseTo(1.7 * 1.5 + 1.05);
    expect([balloons.scaleMultiplier, balloons.maxWidth]).toEqual([1, 400]);
    body.current = null!;
    await view.unmount();
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

  it('방이 새 값을 내도 사람과 말이 그대로면 아바타를 다시 그리지 않는다', async () => {
    // A moving visitor: the room answers a new object each time, with the same players and words.
    let move!: () => void;
    multiplayer.mockImplementation(() => {
      const [, set] = useState(0);
      move = () => set((count) => count + 1);
      return { ...live };
    });
    const view = await mount(room(null));
    const drawn = avatars.mock.calls.length, rendered = multiplayer.mock.calls.length;
    await act(async () => move());
    expect(multiplayer.mock.calls.length).toBeGreaterThan(rendered);
    expect(avatars).toHaveBeenCalledTimes(drawn);
    await view.unmount();
  });
});

describe('로그인하지 않은 방문자의 말하기 자리', () => {
  it('로그인 링크만 두고, 로그인한 뒤 이 섬으로 돌아온다', async () => {
    const view = await mount(
      <MemoryRouter initialEntries={['/@host']}>
        <ChatBar signedIn={false} />
      </MemoryRouter>,
    );
    const links = [...view.container.querySelectorAll('a')];
    expect(links.map((link) => link.textContent)).toEqual(['로그인']);
    expect(links[0]?.getAttribute('href')).toBe('/?next=%2F%40host');
    expect(view.container.textContent).toBe('로그인');
    await view.unmount();
  });
});
