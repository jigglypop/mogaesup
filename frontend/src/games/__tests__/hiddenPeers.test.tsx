import { act } from 'react';
import type { RapierRigidBody } from '@react-three/rapier';
import type { Group } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { multiplayer, avatars, ticket } = vi.hoisted(() => ({
  multiplayer: vi.fn(), avatars: vi.fn((_props: { players: ReadonlyMap<string, unknown> }) => null), ticket: vi.fn(),
}));
vi.mock('gaesup-world', async (original) => ({
  ...await original<typeof import('gaesup-world')>(),
  useMultiplayer: multiplayer,
  RemotePlayers: avatars,
}));
vi.mock('../../api/endpoints', () => ({ authApi: { realtimeTicket: ticket } }));

import { mount } from '../../__tests__/mount';
import { LiveAvatars, LiveRoom } from '../../minihome/live';
import { hiddenPeers, useHidePeers, withoutPeers } from '../hiddenPeers';

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
