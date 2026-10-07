import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../teleport', () => ({ standing: () => null, useTeleport: () => () => true }));

import { mount } from '../../__tests__/mount';
import { createVillage } from '../../minihome/village';
import { GameWorld } from '../GameWorld';
import type { Trip } from '../game';
import type { GameSession } from '../protocol';
import { GameContext, type GameRoomValue } from '../room';
import { createGameClient, type GameState } from '../useGameSession';

const me = { id: 'me', name: '나', peer: 'peer-me' };
const HOME: [number, number, number] = [5, 1, 5];

/** The real game client, its state set by hand as its socket would, and its teleports counted. */
function client(state: Partial<GameState>) {
  const real = createGameClient();
  let current: GameState = { session: null, connected: true, synced: true, error: null, ...state };
  const listeners = new Set<() => void>();
  const teleport = vi.fn((_ground: [number, number, number]) => true);
  real.setTeleporter(teleport);
  const game = {
    ...real,
    getState: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTeleporter: () => () => {},
  };
  const set = (changes: Partial<GameState>) =>
    act(() => {
      current = { ...current, ...changes };
      for (const listener of [...listeners]) listener();
    });
  return { game, set, teleport };
}

const playing = (players = [me], stand: [number, number, number] | null = null): GameSession =>
  ({ id: 3, kind: 'nothing', phase: 'playing', startedAt: 100, canClose: false, host: me.id, players, you: me.id, home: null, stand, game: {}, result: null, seq: 1, now: 0 }) as GameSession;

const mounted: { unmount: () => Promise<void> }[] = [];

async function world(state: Partial<GameState>, trip: Trip | null, signedIn = true) {
  const made = client(state);
  made.game.setTrip(trip);
  const room: GameRoomValue = { client: made.game, live: signedIn, building: createVillage, playerRef: { current: null }, signedIn };
  const view = await mount(
    <GameContext.Provider value={room}>
      <GameWorld playerRef={{ current: null as never }} />
    </GameContext.Provider>,
  );
  mounted.push(view);
  return made;
}

describe('게임이 데려간 자리에서 돌아오기', () => {
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
  });

  it('소켓이 다시 붙는 동안은 그대로 두고, 게임이 닫혔거나 나 없이 계속되면 섬의 원래 자리로 돌려보낸다', async () => {
    const trip = { key: '3:100', home: HOME };
    // Reconnecting: nothing known yet, so nobody moves.
    const away = await world({ connected: false, synced: false }, trip);
    expect(away.teleport).not.toHaveBeenCalled();
    away.set({ connected: true, synced: true, session: playing() });
    expect(away.teleport).not.toHaveBeenCalled();
    expect(away.game.trip()).toEqual(trip);
    // The game goes on without the viewer: home.
    away.set({ session: playing([{ ...me, id: 'other' }]) });
    expect(away.teleport.mock.calls).toEqual([[HOME]]);
    expect(away.game.trip()).toBeNull();

    // The session closed while the socket was down: home as soon as the next socket says so.
    const closed = await world({ connected: false, synced: false }, trip);
    closed.set({ connected: true, synced: true, session: null });
    expect(closed.teleport.mock.calls).toEqual([[HOME]]);
    // Never taken anywhere: nothing to do.
    const home = await world({ session: null }, null);
    expect(home.teleport).not.toHaveBeenCalled();
  });

  it('구경 자리에서 보는 사람은 게임이 이어지는 동안 그대로 두고, 끝나면 돌려보낸다', async () => {
    const trip = { key: '3:100', home: HOME };
    const watching = await world({ session: playing([{ ...me, id: 'racer' }], [0, 0, -8]) }, trip);
    expect(watching.teleport).not.toHaveBeenCalled();
    watching.set({ session: { ...playing([{ ...me, id: 'racer' }]), phase: 'ended' } as GameSession });
    expect(watching.teleport.mock.calls).toEqual([[HOME]]);
    expect(watching.game.trip()).toBeNull();
  });

  it('로그아웃하면 다시 붙을 소켓이 없으니 바로 돌려보낸다', async () => {
    const away = await world({ connected: false, synced: false }, { key: '3:100', home: HOME }, false);
    expect(away.teleport.mock.calls).toEqual([[HOME]]);
    expect(away.game.trip()).toBeNull();
  });
});
