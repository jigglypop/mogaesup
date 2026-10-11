import { act } from 'react';
import type { RapierRigidBody } from '@react-three/rapier';
import type { Group } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { multiplayer, avatars, ticket, moves, HOME } = vi.hoisted(() => ({
  multiplayer: vi.fn(), avatars: vi.fn((_props: { players: ReadonlyMap<string, unknown> }) => null), ticket: vi.fn(),
  moves: vi.fn((_ground: [number, number, number]) => true),
  HOME: [5, 1, 5] as [number, number, number],
}));
vi.mock('gaesup-world', async (original) => ({
  ...await original<typeof import('gaesup-world')>(),
  useMultiplayer: multiplayer,
  RemotePlayers: avatars,
}));
vi.mock('../../api/endpoints', () => ({ authApi: { realtimeTicket: ticket } }));
// 임포스터's World draws in the island's canvas; here it runs only what it runs first, the game's sync.
vi.mock('../impostor/World', async () => {
  const { useImpostorSync } = await import('../impostor/sync');
  return {
    ImpostorWorld: (props: Parameters<typeof useImpostorSync>[0]) => {
      useImpostorSync(props);
      return null;
    },
  };
});
// The island world's moves of the viewer's character, counted; the viewer stood at HOME before the game.
vi.mock('../teleport', async (original) => ({
  ...(await original<typeof import('../teleport')>()),
  useTeleport: () => moves,
  standing: () => HOME,
}));

import { mount } from '../../__tests__/mount';
import { LiveAvatars, LiveRoom } from '../../minihome/live';
import { createVillage } from '../../minihome/village';
import { GameWorld } from '../GameWorld';
import { hiddenPeers, useHidePeers, withoutPeers } from '../hiddenPeers';
import type { GameSession, SessionPlayer, Vec3 } from '../protocol';
import { GameContext, type GameRoomValue } from '../room';
import { createGameClient } from '../useGameSession';
import { FakeSocket } from './socket';

/** Like the engine's live map: copies made from one share its latest states. */
class SharedMap<T> extends Map<string, T> {
  channel: { latest: Map<string, T> };
  constructor(source?: Iterable<readonly [string, T]>) {
    super(source ?? []);
    this.channel = source instanceof SharedMap ? (source.channel as { latest: Map<string, T> }) : { latest: new Map(this) };
  }
  override delete(id: string) {
    this.channel.latest.delete(id);
    return super.delete(id);
  }
}

const shown = () => [...avatars.mock.calls.at(-1)![0].players.keys()];

describe('게임이 숨긴 사람', () => {
  afterEach(() => {
    hiddenPeers.clear('test');
    hiddenPeers.clear('other');
  });

  it('숨길 사람이 없으면 같은 지도를, 있으면 같은 종류의 사본에서만 뺀다', () => {
    const players = new SharedMap([['p1', 'a'], ['p2', 'b']]);
    expect(withoutPeers(players, new Set(['nobody']))).toBe(players);
    const copy = withoutPeers(players, new Set(['p1'])) as SharedMap<string>;
    expect(copy).toBeInstanceOf(SharedMap);
    expect(copy.channel).toBe(players.channel);
    expect([...copy.keys()]).toEqual(['p2']);
    expect([...players.keys()]).toEqual(['p1', 'p2']);
    expect(players.channel.latest.has('p1')).toBe(true);
  });

  it('출처마다 따로 숨기고 합친 것을 내며, 바뀔 때만 새 값이 된다', () => {
    hiddenPeers.set('test', ['p1', 'p1']);
    const first = hiddenPeers.get();
    hiddenPeers.set('other', ['p1']);
    expect(hiddenPeers.get()).toBe(first);
    hiddenPeers.set('other', ['p2']);
    expect([...hiddenPeers.get()].sort()).toEqual(['p1', 'p2']);
    hiddenPeers.clear('test');
    expect([...hiddenPeers.get()]).toEqual(['p2']);
  });

  it('섬의 아바타는 숨긴 client id를 빼고 그리고, 숨김을 거두면 원래 지도를 그린다', async () => {
    const players = new SharedMap([['p1', { name: '하나' }], ['p2', { name: '둘' }]]);
    multiplayer.mockReturnValue({
      connectionStatus: 'connected', isConnected: true, localPlayerId: 'me', connect: vi.fn(), disconnect: vi.fn(), updateConfig: vi.fn(),
      players, speechByPlayerId: new Map(),
    });
    const body = { current: null! as RapierRigidBody };
    const visual = { current: null! as Group };
    function Ghosts({ ids }: { ids: string[] }) {
      useHidePeers('test', ids);
      return null;
    }
    const island = (ids: string[]) => (
      <LiveRoom username="host" viewer={null} characterUrl="/models/a.glb" playerRef={body} visualRotationRef={visual}>
        <LiveAvatars playerRef={body} />
        <Ghosts ids={ids} />
      </LiveRoom>
    );
    const view = await mount(island([]));
    expect(avatars.mock.calls.at(-1)![0].players).toBe(players);
    await view.rerender(island(['p1']));
    expect(shown()).toEqual(['p2']);
    await act(async () => hiddenPeers.set('other', ['p2']));
    expect(shown()).toEqual([]);
    await act(async () => hiddenPeers.clear('other'));
    await view.unmount();
    // Unmounted, the game's list goes with it.
    expect(hiddenPeers.get().size).toBe(0);
    const again = await mount(island([]));
    expect(avatars.mock.calls.at(-1)![0].players).toBe(players);
    await again.unmount();
  });
});

describe('임포스터 중인 섬', () => {
  const crew: SessionPlayer[] = [
    { id: 'me', name: '나', peer: 'peer-me' },
    { id: 'b', name: '비', peer: 'peer-b' },
    { id: 'c', name: '씨', peer: 'peer-c' },
    { id: 'd', name: '디', peer: 'peer-d' },
  ];
  const SPAWN: Vec3 = [1.6, 80, 0];
  const SEAT: Vec3 = [2.4, 80, 1];
  const playing = (players: SessionPlayer[], hidden: string[], seq: number, meeting: unknown = null) => {
    const session: GameSession = {
      kind: 'impostor', phase: 'playing', host: 'me', players, you: 'me', result: null, seq, now: 5_000_000,
      game: { phase: meeting ? 'discuss' : 'play', alive: true, hidden, spawn: SPAWN, venting: null, vents: [], meeting },
    };
    return { type: 'Session', session };
  };
  const hidden = () => [...hiddenPeers.get()].sort();
  const socket = () => FakeSocket.made.at(-1)!;
  async function island() {
    vi.stubGlobal('WebSocket', FakeSocket);
    moves.mockClear();
    const client = createGameClient();
    const room: GameRoomValue = { client, live: true, building: createVillage, playerRef: { current: null } };
    const view = await mount(
      <GameContext.Provider value={room}>
        <GameWorld playerRef={{ current: null! as RapierRigidBody }} />
      </GameContext.Provider>,
    );
    client.connect('ws://island/1', () => {});
    socket().open();
    return { client, view };
  }
  const again = (client: ReturnType<typeof createGameClient>, n: number) => {
    client.connect(`ws://island/${n}`, () => {});
    socket().open();
  };

  afterEach(() => vi.unstubAllGlobals());

  it('게임 소켓이 끊겼다 다시 붙는 동안에도 숨긴 사람(게임을 떠난 죽은 사람도)은 숨기고, 우주선에서 내리지 않는다', async () => {
    const { client, view } = await island();
    socket().receive(playing(crew, ['b', 'd'], 1));
    expect(hidden()).toEqual(['peer-b', 'peer-d']);
    // D leaves the game but stays on the island; the server still hides D.
    socket().receive(playing(crew.slice(0, 3), ['b', 'd'], 2));
    socket().drop(4408);
    expect(hidden()).toEqual(['peer-b', 'peer-d']);
    again(client, 2);
    socket().receive(playing(crew.slice(0, 3), ['b', 'c', 'd'], 3));
    expect(hidden()).toEqual(['peer-b', 'peer-c', 'peer-d']);
    // Into the ship once; never home and back.
    expect(moves.mock.calls).toEqual([[SPAWN]]);
    // The session gone: everyone shows, and home.
    socket().receive({ type: 'Session', session: null });
    expect(hidden()).toEqual([]);
    expect(moves.mock.calls).toEqual([[SPAWN], [HOME]]);
    await view.unmount();
  });

  it('회의 중에 게임 소켓이 끊겼다 다시 붙어도 자리로 다시 옮기지 않는다', async () => {
    const { client, view } = await island();
    const meeting = { number: 1, seat: SEAT };
    socket().receive(playing(crew, [], 1, meeting));
    expect(moves.mock.calls).toEqual([[SPAWN], [SEAT]]);
    socket().drop();
    again(client, 2);
    socket().receive(playing(crew, [], 2, meeting));
    expect(moves.mock.calls).toEqual([[SPAWN], [SEAT]]);
    await view.unmount();
  });

  it('서버가 이 사람에게 소켓을 닫으면(4401·4403) 게임을 내리고 섬의 원래 자리로 돌려보낸다', async () => {
    for (const code of [4401, 4403]) {
      const { view } = await island();
      socket().receive(playing(crew, ['b'], 1));
      socket().drop(code);
      expect(hidden()).toEqual([]);
      expect(moves.mock.calls).toEqual([[SPAWN], [HOME]]);
      await view.unmount();
    }
  });
});
