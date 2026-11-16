import { act, useState } from 'react';
import type { RapierRigidBody } from '@react-three/rapier';
import type { Group } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { multiplayer, avatars, ticket } = vi.hoisted(() => ({
  multiplayer: vi.fn(), avatars: vi.fn((_props: object) => null), ticket: vi.fn(),
}));
vi.mock('gaesup-world', async (original) => ({
  ...await original<typeof import('gaesup-world')>(),
  useMultiplayer: multiplayer,
  RemotePlayers: avatars,
}));
vi.mock('../../api/endpoints', () => ({ authApi: { realtimeTicket: ticket } }));

import { MemoryRouter } from 'react-router-dom';

import type { RealtimeTicket, User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { onSessionDoubt } from '../../auth/sessionWork';
import { useUIConfigStore } from 'gaesup-world';

import { balloonTtl, PERSON_COLORS } from '../balloons/designs';
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
  const room = (viewer: User | null = user, balloon?: string) => <LiveRoom username="host" viewer={viewer}
    viewerBalloon={balloon} characterUrl="/models/assembled.glb" playerRef={body} visualRotationRef={visual}>
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
    expect(options.config.rendering.nameTagHeight).toBeCloseTo(1.7 * 1.5 + 0.4);
    expect(live.connect).toHaveBeenCalledWith({ roomId: 'host', playerName: user.displayName, playerColor: expect.stringMatching(/^#[0-9a-f]{6}$/) });
    await view.unmount();
    expect(live.disconnect).toHaveBeenCalledTimes(1);
  });

  it('말풍선은 엔진이 아니라 섬이 그리며, 방이 열린 동안 엔진의 말풍선은 꺼 둔다', async () => {
    live.speechByPlayerId = new Map([['p1', '안녕']]);
    const view = await mount(room());
    await flush();
    // The engine gets no words to draw over the visitors.
    for (const [props] of avatars.mock.calls) expect(props).not.toHaveProperty('speechByPlayerId');
    expect(useUIConfigStore.getState().config.speechBalloon.enabled).toBe(false);
    await view.unmount();
    expect(useUIConfigStore.getState().config.speechBalloon.enabled).toBe(true);
  });

  it('기본 말풍선은 계정마다의 색으로, 고른 말풍선은 그 색으로 방에 들어가고, 바꾸면 그 색으로 다시 들어간다', async () => {
    const view = await mount(room(user, 'glass'));
    await flush();
    const own = live.connect.mock.calls[0]![0].playerColor;
    expect(PERSON_COLORS).toContain(own);
    // A page that does not know its viewer's balloon (an older server) joins in the same colour.
    await view.rerender(room(user, undefined));
    expect(live.disconnect).not.toHaveBeenCalled();

    await view.rerender(room(user, 'cloud'));
    expect(live.disconnect).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(live.connect).toHaveBeenLastCalledWith({ roomId: 'host', playerName: user.displayName, playerColor: '#4f9fd8' });
    await view.unmount();
  });

  it('방이 끊겨 다시 들어갈 때마다 고른 말풍선의 색으로 들어간다', async () => {
    // The room stays down: the page keeps joining again, each time with a new ticket.
    const view = await mount(room(user, 'heart'));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(12_000));
    expect(live.connect.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [options] of live.connect.mock.calls) expect(options.playerColor).toBe('#d9466f');
    expect(live.disconnect).not.toHaveBeenCalled();
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
    const doubted = vi.fn();
    const stopDoubt = onSessionDoubt(doubted);
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
    // The room it was asked for is gone; that ticket says nothing about the session now.
    expect(doubted).not.toHaveBeenCalled();
    await view.unmount();
    stopDoubt();
  });

  it('티켓 발급 시 쿠키 계정이 이미 바뀌었다면 이전 이름으로 방에 들어가지 않고, 누가 로그인했는지 다시 묻게 한다', async () => {
    const doubted = vi.fn();
    const stopDoubt = onSessionDoubt(doubted);
    ticket.mockResolvedValue(pass('wrong-owner', other));
    const view = await mount(room());
    await flush();
    expect(live.connect).not.toHaveBeenCalled();
    expect(live.updateConfig).not.toHaveBeenCalled();
    expect(doubted).toHaveBeenCalledTimes(1);
    await view.unmount();
    stopDoubt();
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

describe('방에서 말하기', () => {
  afterEach(() => multiplayer.mockReset());

  it('한 말은 글자 수만큼 떠 있고, 함께 있는 사람의 이름 글자는 그 사람 색 위에서 읽히는 색이다', async () => {
    const sendChat = vi.fn();
    const players = new Map([
      ['p1', { name: '외침이', color: '#e0a800' }],
      ['p2', { name: '보통이', color: '#5a8acf' }],
    ]);
    multiplayer.mockReturnValue({ connectionStatus: 'connected', isConnected: true, localPlayerId: 'me', connect: vi.fn(),
      disconnect: vi.fn(), updateConfig: vi.fn(), players, speechByPlayerId: new Map(), localSpeechText: null, sendChat });
    const view = await mount(
      <MemoryRouter>
        <LiveRoom username="host" viewer={null} characterUrl="/models/a.glb" playerRef={{ current: null! as RapierRigidBody }}
          visualRotationRef={{ current: null! as Group }}>
          <ChatBar signedIn />
        </LiveRoom>
      </MemoryRouter>,
    );
    const faces = [...view.container.querySelectorAll<HTMLElement>('.mg-chatbar-people i')];
    expect(faces.map((face) => [face.textContent, face.style.color])).toEqual([['외', 'rgb(29, 24, 48)'], ['보', 'rgb(255, 255, 255)']]);
    const line = '  오늘 섬에 놀러 와 줘서 고마워요  ';
    await type(view.container.querySelector<HTMLInputElement>('input[aria-label="말하기"]')!, line);
    await act(async () => view.container.querySelector('form')!.requestSubmit());
    expect(sendChat).toHaveBeenCalledExactlyOnceWith(line.trim(), { ttlMs: balloonTtl(line.trim()) });
    await view.unmount();
  });
});
