import { act } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../registry', () => ({
  gameOf: (kind: string) =>
    kind === 'kart' || kind === 'impostor' || kind === 'pair'
      ? { kind, replacesIsland: kind !== 'pair', controlsPlayer: kind === 'kart', World: () => null, Panel: () => null, Result: () => null }
      : null,
}));
vi.mock('gaesup-world', async (original) => ({
  ...(await original<typeof import('gaesup-world')>()),
  useWorldInputScope: () => ({ dispatchKey: () => {}, registerSurface: () => () => {}, onBlur: () => () => {} }),
}));

import { mount } from '../../__tests__/mount';
import type { Trip } from '../game';
import { GameSurface } from '../GameSurface';
import type { GameSession } from '../protocol';
import { GameContext, useActiveGame, useGameStage, type GameRoomValue } from '../room';
import { createGameClient, type GameClient, type GameState } from '../useGameSession';

const me = { id: 'me', name: '나', peer: 'p-me' };
const other = { id: 'other', name: '너', peer: 'p-other' };

const session = (kind: string, phase: GameSession['phase'], players = [me]): GameSession =>
  ({ id: 1, kind, phase, startedAt: 10, canClose: true, host: players[0]!.id, players, you: me.id, home: null, stand: null, game: {}, result: null, seq: 1, now: 0 }) as GameSession;

/** The real game client with its state set by hand, as its socket would. */
function client() {
  const real = createGameClient();
  let state: GameState = { session: null, connected: true, synced: true, error: null };
  const listeners = new Set<() => void>();
  const game: GameClient = {
    ...real,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const set = (changes: Partial<GameState>) =>
    act(() => {
      state = { ...state, ...changes };
      for (const listener of [...listeners]) listener();
    });
  return { game, set, listeners };
}

let media: EventTarget & { matches: boolean };

function Probe() {
  const stage = useGameStage();
  const active = useActiveGame();
  return <output data-stage={stage} data-active={active?.definition.kind ?? ''} />;
}

async function surface(room: Partial<GameRoomValue> & { client: GameClient }) {
  const value = { live: true, building: () => ({}) as never, playerRef: { current: null }, ...room } as GameRoomValue;
  const view = await mount(
    <GameContext.Provider value={value}>
      <GameSurface className="mg-world">
        <input defaultValue="쓰던 이야기" />
        <Probe />
      </GameSurface>
    </GameContext.Provider>,
  );
  const world = () => view.container.querySelector<HTMLElement>('.mg-world')!;
  const probe = () => view.container.querySelector('output')!;
  return { ...view, world, probe, pad: () => view.container.querySelector('.mg-walking-controls') };
}

describe('게임이 섬 자리를 차지하는 동안', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('카트·임포스터가 진행되는 동안만 섬을 게임 맵으로 바꾸고, 끝나면 섬 화면을 그대로 되돌린다', async () => {
    media = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal('matchMedia', () => media);
    const made = client();
    const shown = await surface({ client: made.game });
    const field = shown.container.querySelector('input')!;
    expect(shown.world().dataset.environment).toBe('island');
    await made.set({ session: session('kart', 'lobby') });
    expect(shown.probe().dataset.stage).toBe('island');
    // Racing: the game drives the viewer's body; on foot in the ship; watching someone else's race.
    await made.set({ session: session('kart', 'playing') });
    expect([shown.world().dataset.environment, shown.probe().dataset.stage]).toEqual(['game', 'drive']);
    await made.set({ session: session('impostor', 'playing') });
    expect(shown.probe().dataset.stage).toBe('play');
    await made.set({ session: session('kart', 'playing', [other]) });
    expect(shown.probe().dataset.stage).toBe('watch');
    // A game that leaves the island as it is, and every game once it is over.
    await made.set({ session: session('pair', 'playing') });
    expect([shown.world().dataset.environment, shown.probe().dataset.stage]).toEqual(['island', 'island']);
    await made.set({ session: session('kart', 'ended') });
    expect(shown.world().dataset.environment).toBe('island');
    // What was typed on the island is still there: its panels were only put away.
    expect(shown.container.querySelector('input')).toBe(field);
    expect(field.value).toBe('쓰던 이야기');
    await shown.unmount();
    expect(made.listeners.size).toBe(0);
  });

  it('게임 소켓이 잠깐 끊긴 동안에는 게임 맵과 게임을 그대로 두고, 떠나 있지 않으면 섬으로 돌아간다', async () => {
    media = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal('matchMedia', () => media);
    const made = client();
    const shown = await surface({ client: made.game });
    await made.set({ session: session('kart', 'playing') });
    made.game.setTrip({ key: '1:10', home: [0, 0, 0] } satisfies Trip);
    expect(shown.probe().dataset.active).toBe('kart');
    // The socket drops: nothing known for now, but the viewer is still away on the race's trip.
    await made.set({ session: null, connected: false, synced: false });
    expect([shown.world().dataset.environment, shown.probe().dataset.stage, shown.probe().dataset.active]).toEqual(['game', 'drive', 'kart']);
    // Back, with the race over: the island.
    await made.set({ session: session('kart', 'ended'), connected: true, synced: true });
    expect([shown.probe().dataset.stage, shown.probe().dataset.active]).toEqual(['island', 'kart']);
    // Down again with no trip: nothing to keep.
    made.game.setTrip(null);
    await made.set({ session: null, connected: false, synced: false });
    expect([shown.probe().dataset.stage, shown.probe().dataset.active]).toEqual(['island', '']);
    await shown.unmount();
  });

  it('꾸미는 동안과 로그아웃한 뒤에는 섬 그대로다', async () => {
    media = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal('matchMedia', () => media);
    const decorating = client();
    const owner = await surface({ client: decorating.game, decorating: true });
    await decorating.set({ session: session('impostor', 'playing') });
    expect(owner.world().dataset.environment).toBe('island');
    await owner.unmount();
    const signedOut = client();
    const left = await surface({ client: signedOut.game, signedIn: false });
    await signedOut.set({ session: session('impostor', 'playing') });
    expect(left.world().dataset.environment).toBe('island');
    await left.unmount();
  });

  it('터치 화면에서는 섬과 구경하는 게임에만 걷기 패드를 두고, 게임을 하는 동안에는 게임이 자기 조작을 둔다', async () => {
    media = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal('matchMedia', () => media);
    const made = client();
    const shown = await surface({ client: made.game });
    expect(shown.pad()?.getAttribute('data-placement')).toBe('island');
    await made.set({ session: session('kart', 'playing', [other]) });
    expect(shown.pad()?.getAttribute('data-placement')).toBe('game');
    await made.set({ session: session('kart', 'playing') });
    expect(shown.pad()).toBeNull();
    await made.set({ session: session('impostor', 'playing') });
    expect(shown.pad()).toBeNull();
    await made.set({ session: null });
    expect(shown.pad()).not.toBeNull();
    // Not on a desktop's mouse and keys.
    await act(() => {
      media.matches = false;
      media.dispatchEvent(new Event('change'));
    });
    expect(shown.pad()).toBeNull();
    await shown.unmount();
    // Nor while decorating.
    media.matches = true;
    const decorating = await surface({ client: client().game, decorating: true });
    expect(decorating.pad()).toBeNull();
    await decorating.unmount();
  });
});
