import { act, type ReactNode } from 'react';

import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate, useParams, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeView, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { saveUnsavedWork } from '../../auth/sessionWork';
import type { IslandSaver } from '../edit/save';
import Minihome from '../Minihome';
import { IslandTooLargeError } from '../persistence';
import { fakeWorld } from './fakeWorld';

// The island without its engine, live room and side panels: what is left is its leaving, around a saver whose saves keep
// failing (the line is down), so leaving the editor asks whether to go without the edits. A test may put a real saver
// in its place.
const { saver, real, history, leaveIsland } = vi.hoisted(() => {
  const state = {
    phase: 'ready',
    saving: false,
    dirty: true,
    conflict: false,
    problem: { kind: 'network', message: '인터넷 연결이 끊겼어요.' },
    lastSavedAt: null,
    bytes: null,
  };
  return {
    saver: {
      disposed: false,
      getState: () => state,
      subscribe: () => () => {},
      load: vi.fn(async () => true),
      save: vi.fn(async () => false),
      flush: vi.fn(async () => false),
      overwrite: vi.fn(async () => false),
      reloadLatest: vi.fn(async () => true),
      changed: vi.fn(),
      dispose: vi.fn(),
    },
    real: { saver: null as IslandSaver | null },
    history: { start: vi.fn(), stop: vi.fn() },
    leaveIsland: vi.fn(),
  };
});
vi.mock('gaesup-world', () => ({
  GaesupWorld: ({ children }: { children: ReactNode }) => children,
  ToastHost: () => null,
  useAmbientBgm: () => {},
  useGameTime: () => ({ hour: 12, minute: 0 }),
  useGaesupStoreApi: () => ({ getState: () => ({ setCameraOption: () => {} }) }),
  useWeatherStore: (pick: (state: { current: null }) => unknown) => pick({ current: null }),
}));
vi.mock('../../games/GameDock', () => ({ GameDock: () => null }));
vi.mock('../../games/GameWorld', () => ({ GameWorld: () => null }));
vi.mock('../../games/room', () => ({ GameRoom: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../shell/Shell', () => ({
  Brand: () => null,
  Rail: () => <Link to="/explore">둘러보기</Link>,
  TopActions: ({ children }: { children: ReactNode }) => children,
  initialOf: (name: string) => name[0],
  toneOf: () => '0',
}));
vi.mock('../Decorate', () => ({ Decorate: () => <p>꾸미기 도구</p> }));
vi.mock('../edit/EditChrome', () => ({
  EditBar: ({ onExit }: { onExit: () => void }) => <button onClick={onExit}>나가기</button>,
  EditHelp: () => null,
  SaveBanners: () => null,
  StartBanner: () => null,
}));
vi.mock('../edit/history', () => ({ createEditHistory: () => history, readParts: () => null, sameParts: () => true }));
vi.mock('../edit/leave', async (original) => ({ ...(await original<typeof import('../edit/leave')>()), leaveIsland }));
vi.mock('../edit/save', async (original) => ({ ...(await original<typeof import('../edit/save')>()), createIslandSaver: () => real.saver ?? saver }));
vi.mock('../edit/session', () => ({ createEditSession: () => ({ getState: () => ({ active: false }), subscribe: () => () => {}, dispose: () => {} }) }));
vi.mock('../edit/useIslandStart', () => ({ useIslandStart: () => ({ failed: false, retry: () => {} }) }));
vi.mock('../Guestbook', () => ({ Guestbook: () => null }));
vi.mock('../Ilchons', () => ({ NeighborsTab: () => null, useNeighbors: () => ({ list: [], received: [], status: null, error: '', act: () => {} }) }));
vi.mock('../InteractButton', () => ({ InteractButton: () => null }));
vi.mock('../live', () => ({
  ChatBar: () => null,
  LiveAvatars: () => null,
  LiveRoom: ({ children }: { children: ReactNode }) => children,
  usePresence: () => ({ connected: false, count: 1 }),
}));
vi.mock('../persistence', async (original) => ({ ...(await original<typeof import('../persistence')>()), createHomeSaveAdapter: () => ({ dispose: () => {} }) }));
vi.mock('../Profile', () => ({ About: () => null, ProfileHeader: () => null, minimeOf: () => undefined }));
vi.mock('../ResidentsWorld', () => ({ ResidentGreeting: () => null, ResidentsWorld: () => null }));
vi.mock('../Scene', () => ({ Scene: () => null }));
vi.mock('../Settings', () => ({ SettingsMenu: () => null }));
vi.mock('../ShareLink', () => ({ SharedToast: () => null, ShareLink: () => null }));
vi.mock('../StatusPanel', () => ({ StatusPanel: () => null }));
vi.mock('../village', () => ({ createVillage: () => ({}), spawnFor: () => [0, 1, 0] }));
vi.mock('../world', () => ({
  MINIHOME_WORLD_ID: 'minihome',
  createMinihomeRuntime: () => ({ buildingStore: { subscribe: () => () => {}, getState: () => ({}) }, dispose: async () => {} }),
}));
vi.mock('../WorldKeyboard', () => ({ WorldKeyboard: () => null }));
vi.mock('../WorldLoading', () => ({ WorldLoading: () => null }));

const owner: User = { id: 'owner', username: 'mogae', displayName: '모개', role: 'user' };
const view: HomeView = {
  isOwner: true,
  visits: { today: 0, total: 0 },
  profile: {
    ownerId: 'owner',
    username: 'mogae',
    ownerName: '모개',
    title: '모개숲',
    statusMessage: '',
    mood: 0,
    minime: 'man',
    emoji: '😊',
    visibility: 'public',
    updatedAt: '2026-10-01T00:00:00Z',
  },
};

let go!: NavigateFunction;
let path = '';
function Driver() {
  go = useNavigate();
  path = useLocation().pathname;
  return null;
}
/** `/@mogae` and `/@mogae/edit` are one route, as in the app: going between them keeps the same island open. */
function Island() {
  const { '*': rest = '' } = useParams();
  return (
    <Minihome
      view={view}
      viewer={owner}
      viewerMinime="man"
      minimes={[]}
      studioItems={[]}
      npcItems={[]}
      viewerLook={null}
      onLook={() => {}}
      editing={rest === 'edit'}
      onView={() => {}}
    />
  );
}
const app = () => (
  <MemoryRouter initialEntries={['/@mogae/edit']}>
    <Driver />
    <Routes>
      <Route path="/" element={<p>로그인</p>} />
      <Route path="/explore" element={<p>둘러보기</p>} />
      <Route path="/:slug/*" element={<Island />} />
    </Routes>
  </MemoryRouter>
);
const settle = () => act(async () => { for (let round = 0; round < 5; round++) await new Promise((done) => setTimeout(done, 0)); });
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};
const exitButton = (container: HTMLElement) => [...container.querySelectorAll('button')].find((button) => button.textContent === '나가기')!;

describe('꾸미기에서 저장하지 못한 변경을 버리고 나가기', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(window.confirm).mockRestore();
    vi.clearAllMocks();
    real.saver?.dispose();
    real.saver = null;
  });

  it('섬으로 나가면 섬은 열린 채라 변경을 그 자리에서 버리고 저장된 섬을 다시 불러오며, 그 뒤 섬을 떠날 때는 버리지 않는다', async () => {
    const { container, unmount } = await mount(app());
    await click(exitButton(container));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(path).toBe('/@mogae');
    expect(saver.reloadLatest).toHaveBeenCalledTimes(1);
    // Undo starts again from the island loaded back.
    expect(history.stop).toHaveBeenCalled();
    expect(history.start).toHaveBeenCalled();

    await act(async () => go('/explore'));
    expect(leaveIsland).toHaveBeenCalledExactlyOnceWith(saver, expect.any(Function), false, 'mogae');
    await unmount();
  });

  it('버리고 섬으로 나간 뒤 다시 꾸민 변경은 다시 로그인하러 가거나 뒤로 가 섬을 떠나도 버리지 않는다', async () => {
    const { container, unmount } = await mount(app());
    await click(exitButton(container));
    await act(async () => go('/@mogae/edit'));
    // The new edits could not be saved either; the owner leaves without the editor asking (the sign-in link, Back).
    await act(async () => go('/'));
    expect(leaveIsland).toHaveBeenCalledExactlyOnceWith(saver, expect.any(Function), false, 'mogae');
    await unmount();
  });

  it('저장이 오가는 중에 버리고 섬으로 나가면 그 저장이 끝나도 버린 편집을 다시 보내지 않고, 다시 불러올 때까지 꾸밀 수 없다', async () => {
    const world = fakeWorld();
    const { createIslandSaver } = await vi.importActual<typeof import('../edit/save')>('../edit/save');
    const island = createIslandSaver({ system: world.system, adapter: world.adapter, writable: true });
    await island.load();
    real.saver = island;
    // A slow line: every save waits until the test answers it, and so does loading the stored island again.
    const answers: ((error: unknown) => void)[] = [];
    world.system.save.mockImplementation(() => new Promise<void>((_done, fail) => void answers.push(fail)));
    let loaded!: (applied: boolean) => void;
    world.system.load.mockImplementationOnce(() => new Promise<boolean>((done) => (loaded = done)));
    world.edit();
    island.changed();
    void island.save();
    const { container, unmount } = await mount(app());
    await click(exitButton(container));

    // The save on its way fails and the one leaving asked for goes after it; once that one fails too, the owner leaves
    // without the edits.
    await act(async () => answers[0]!(new TypeError('Failed to fetch')));
    await settle();
    expect(world.system.save).toHaveBeenCalledTimes(2);
    expect(window.confirm).not.toHaveBeenCalled();
    await act(async () => answers[1]!(new TypeError('Failed to fetch')));
    await settle();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(path).toBe('/@mogae');
    expect(island.getState().phase).toBe('loading');

    await act(async () => go('/@mogae/edit'));
    expect(container.textContent).toContain('섬을 불러오는 중이에요.');
    expect(container.textContent).not.toContain('꾸미기 도구');
    expect(history.start).not.toHaveBeenCalled();

    await act(async () => loaded(true));
    await settle();
    expect(world.system.save).toHaveBeenCalledTimes(2);
    expect(world.system.load).toHaveBeenCalledTimes(2);
    expect(island.getState()).toMatchObject({ phase: 'ready', dirty: false });
    expect(container.textContent).toContain('꾸미기 도구');
    expect(history.start).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('저장이 오가는 중에 나가면 그 뒤에 놓은 것까지 저장되었는지 듣고, 저장되지 않았으면 물어 남을 수 있다', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const world = fakeWorld();
    const { createIslandSaver } = await vi.importActual<typeof import('../edit/save')>('../edit/save');
    const island = createIslandSaver({ system: world.system, adapter: world.adapter, writable: true });
    await island.load();
    real.saver = island;
    let stored!: () => void;
    world.system.save.mockImplementationOnce(() => new Promise<void>((done) => (stored = done)));
    world.edit();
    island.changed();
    void island.save();
    // The last thing placed, while that save is on its way, makes the island too large to save.
    world.edit();
    island.changed();
    world.answers.push(new IslandTooLargeError(3 * 1024 * 1024));
    const { container, unmount } = await mount(app());
    await click(exitButton(container));

    await act(async () => stored());
    await settle();
    expect(world.system.save).toHaveBeenCalledTimes(2);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(path).toBe('/@mogae/edit');
    expect(island.getState()).toMatchObject({ dirty: true, problem: { kind: 'tooLarge' } });
    await unmount();
  });

  it('다른 곳으로 가는 링크로 나가며 버리면 섬을 닫으면서 변경을 버린다', async () => {
    const { container, unmount } = await mount(app());
    await click([...container.querySelectorAll('a')].find((link) => link.textContent === '둘러보기')!);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(path).toBe('/explore');
    expect(saver.reloadLatest).not.toHaveBeenCalled();
    expect(leaveIsland).toHaveBeenCalledExactlyOnceWith(saver, expect.any(Function), true, 'mogae');
    await unmount();
  });
});

describe('로그아웃하기 전에', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false })));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    real.saver?.dispose();
    real.saver = null;
  });

  it('주인의 섬에 저장하지 않은 편집이 있으면 그 저장이 끝날 때까지 기다린다', async () => {
    const world = fakeWorld();
    const { createIslandSaver } = await vi.importActual<typeof import('../edit/save')>('../edit/save');
    const island = createIslandSaver({ system: world.system, adapter: world.adapter, writable: true });
    await island.load();
    real.saver = island;
    let finish!: () => void;
    world.system.save.mockImplementationOnce(() => new Promise<void>((done) => (finish = done)));
    const { unmount } = await mount(app());
    world.edit();
    const saved = vi.fn();
    await act(async () => void saveUnsavedWork().then(saved));
    await settle();
    expect(world.system.save).toHaveBeenCalledTimes(1);
    expect(saved).not.toHaveBeenCalled();
    await act(async () => finish());
    await settle();
    expect(saved).toHaveBeenCalledTimes(1);
    expect(island.getState()).toMatchObject({ saving: false, dirty: false });
    await unmount();
  });
});
