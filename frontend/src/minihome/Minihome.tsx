import './minihome.css';
import './edit/edit.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { RapierRigidBody } from '@react-three/rapier';

import { useNavigate } from 'react-router-dom';
import { DefaultLoadingManager } from 'three';

import {
  DialogBox,
  GaesupWorld,
  InteractionPrompt,
  ToastHost,
  useAmbientBgm,
  useGameTime,
  useGaesupStoreApi,
  type WorldQuality,
} from 'gaesup-world';

import { homeApi } from '../api/endpoints';
import type { CatalogItem, HomeView, ProfileChanges, User } from '../api/types';
import { Brand, initialOf, Rail, toneOf, TopActions, usePopover } from '../shell/Shell';
import { Icon } from '../ui/icons';
import { Decorate } from './Decorate';
import { EditContext, useEditState, useHistory, useSaver } from './edit/context';
import { SaveBanners, SaveStatus, ShortcutHelp } from './edit/EditChrome';
import { createEditHistory, readParts, sameParts } from './edit/history';
import { createIslandSaver, type IslandSaver } from './edit/save';
import { createEditSession, type EditSession } from './edit/session';
import { useEditKeys } from './edit/useEditKeys';
import { Guestbook } from './Guestbook';
import { NeighborsTab, useNeighbors } from './Ilchons';
import { ChatBar, LiveAvatars, LiveRoom, usePresence } from './live';
import { createHomeSaveAdapter } from './persistence';
import { About, minimeOf, ProfileHeader } from './Profile';
import { Scene, type SceneSettings } from './Scene';
import { StatusPanel } from './StatusPanel';
import { useStored } from './stored';
import { createVillage } from './village';
import { createMinihomeRuntime, MINIHOME_WORLD_ID, modelUrl } from './world';
import { WorldLoading } from './WorldLoading';

// Catalog models and saved islands carry page-relative `gltf/...` URLs; anchor them at the site root for `/@username`.
DefaultLoadingManager.setURLModifier((url) => (url.startsWith('gltf/') ? `/${url}` : url));

/** A north-facing high angle, like a diorama seen from the south; a left drag turns it, a left click walks there. */
const CAMERA = {
  type: 'thirdPerson',
  xDistance: -4,
  yDistance: 10,
  zDistance: -10,
  fov: 42,
  dragOrbit: 'all',
  // Trees and houses between the player and the camera turn see-through; the camera keeps its distance.
  collisionMode: 'fade',
} as const;

type PanelTab = 'guestbook' | 'neighbors' | 'about';
const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: 'guestbook', label: '방명록' },
  { id: 'neighbors', label: '이웃' },
  { id: 'about', label: '소개' },
];
const KEYS = [
  ['WASD', '이동'],
  ['클릭', '가기'],
  ['드래그', '시점'],
] as const;
/** The same, for a finger; CSS shows whichever list fits the device's pointer. */
const TOUCH_KEYS = [
  ['탭', '가기'],
  ['드래그', '시점'],
] as const;

function KeyHints({ keys, touch = false }: { keys: typeof KEYS | typeof TOUCH_KEYS; touch?: boolean }) {
  return (
    <div className={`mg-keys${touch ? ' is-touch' : ''}`} aria-label="조작">
      {keys.map(([key, label]) => (
        <span key={key} className="mg-kbd">
          <kbd>{key}</kbd>
          {label}
        </span>
      ))}
    </div>
  );
}
const QUALITY: { value: WorldQuality & string; label: string }[] = [
  { value: 'auto', label: '자동' },
  { value: 'high', label: '높음' },
  { value: 'medium', label: '보통' },
  { value: 'low', label: '낮음' },
];

function TimeChip() {
  const time = useGameTime();
  const day = time.hour >= 6 && time.hour < 18;
  const hour = time.hour % 12 === 0 ? 12 : time.hour % 12;
  return (
    <span className="mg-pill mg-glass mg-time">
      <Icon name={day ? 'sun' : 'moon'} />
      {time.hour < 12 ? '오전' : '오후'} {hour}:{String(time.minute).padStart(2, '0')}
    </span>
  );
}

function Bgm({ enabled }: { enabled: boolean }) {
  useAmbientBgm(enabled);
  return null;
}

/** Follows the viewer's choice of what happens when something hides the player. */
function CameraOcclusion({ fade }: { fade: boolean }) {
  const store = useGaesupStoreApi();
  useEffect(() => {
    store.getState().setCameraOption({ collisionMode: fade ? 'fade' : 'push' });
  }, [store, fade]);
  return null;
}

function Switch({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="mg-switch">
      <span>
        <b>{label}</b>
        <small>{hint}</small>
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

type SettingsProps = {
  settings: SceneSettings;
  onChange: (next: Partial<SceneSettings>) => void;
  bgm: boolean;
  onBgm: (on: boolean) => void;
  onPerformance: () => void;
};

/** How the world draws on this device; kept per viewer. */
function SettingsMenu({ settings, onChange, bgm, onBgm, onPerformance }: SettingsProps) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="mg-anchor" ref={ref}>
      <button className="mg-icon-btn" aria-label="화면 설정" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="gear" />
      </button>
      {open && (
        <div className="mg-popover mg-menu mg-settings is-right" role="dialog" aria-label="화면 설정">
          <p className="mg-menu-title">화면 품질</p>
          <div className="mg-tabs" role="radiogroup" aria-label="화면 품질">
            {QUALITY.map((option) => (
              <button key={option.value} role="radio" aria-checked={settings.quality === option.value} onClick={() => onChange({ quality: option.value })}>
                {option.label}
              </button>
            ))}
          </div>
          <Switch label="후처리" hint="블룸·톤매핑. 켤 때만 불러와요" checked={settings.postProcessing} onChange={(postProcessing) => onChange({ postProcessing })} />
          <Switch
            label="고품질 조명"
            hint="섬에 튄 햇빛과 하늘빛(월드 GI), 반사를 더해요. WebGPU에서만, 후처리와 함께 켜져요"
            checked={settings.postProcessing && !!settings.cinematic}
            onChange={(cinematic) => onChange(cinematic ? { cinematic, postProcessing: true } : { cinematic })}
          />
          <Switch
            label="가리면 반투명"
            hint="앞을 가린 나무나 집을 반투명하게 해요. 끄면 카메라가 앞으로 당겨져요"
            checked={settings.cameraFade ?? true}
            onChange={(cameraFade) => onChange({ cameraFade })}
          />
          <Switch label="절전 모드" hint="입력이 2초 없으면 30fps로 그려요" checked={settings.idleThrottle} onChange={(idleThrottle) => onChange({ idleThrottle })} />
          <Switch label="배경 음악" hint="섬의 소리를 틀어요" checked={bgm} onChange={onBgm} />
          <button
            className="mg-btn is-quiet is-small"
            onClick={() => {
              setOpen(false);
              onPerformance();
            }}
          >
            <Icon name="gauge" /> 성능 보기
          </button>
        </div>
      )}
    </div>
  );
}

function IslandPill({ view, minimes }: { view: HomeView; minimes: CatalogItem[] }) {
  const { profile } = view;
  const presence = usePresence();
  const minime = minimeOf(view, minimes);
  return (
    <span className="mg-pill mg-glass mg-island-pill">
      <span className="mg-avatar is-round">{minime?.thumbnailUrl ? <img src={minime.thumbnailUrl} alt="" /> : profile.emoji}</span>
      <span className="mg-island-name">
        <h1>{profile.title}</h1>
        <small>@{profile.username}</small>
      </span>
      {presence.connected && presence.count > 1 && (
        <span className="mg-chip is-soft mg-presence">
          <i className="mg-dot" /> {presence.count}명 함께
        </span>
      )}
      {!view.isOwner && <span className="mg-badge">놀러 옴</span>}
    </span>
  );
}

export type MinihomeProps = {
  view: HomeView;
  viewer: User | null;
  /** The 미니미 the viewer walks the island as: the owner's own, or the visitor's. */
  viewerMinime: string;
  minimes: CatalogItem[];
  /** Furniture copied in from the character studio, for the decorating drawer. */
  studioItems: CatalogItem[];
  /** The owner's decorating mode, at `/@username/edit`. */
  editing: boolean;
  onView: (view: HomeView) => void;
};

type EditBarProps = { view: HomeView; session: EditSession; saver: IslandSaver; onSave: () => void; onExit: () => void };

/** The decorating top bar: save state, undo and redo, leaving and saving; it also owns the decorating shortcuts. */
function EditBar({ view, session, saver, onSave, onExit }: EditBarProps) {
  const history = useHistory(session.history);
  const saving = useSaver(saver).saving;
  useEditKeys(session, { save: onSave });
  return (
    <header className="mg-topbar">
      <div className="mg-topbar-left">
        <Brand />
        <span className="mg-pill mg-glass mg-edit-title">
          <span>{view.profile.title}</span>
          <span className="mg-badge is-draft">꾸미는 중</span>
        </span>
      </div>
      <div className="mg-topbar-right">
        <SaveStatus saver={saver} />
        <span className="mg-pill mg-glass mg-undo">
          <button className="mg-icon-btn is-quiet" aria-label="되돌리기" title="되돌리기 (Ctrl+Z)" disabled={!history.canUndo} onClick={history.undo}>
            <Icon name="undo" />
          </button>
          <button className="mg-icon-btn is-quiet" aria-label="다시 하기" title="다시 하기 (Ctrl+Shift+Z)" disabled={!history.canRedo} onClick={history.redo}>
            <Icon name="redo" />
          </button>
        </span>
        <button className="mg-btn" onClick={onExit}>
          나가기
        </button>
        <button className="mg-btn is-primary" title="저장 (Ctrl+S)" disabled={saving} onClick={onSave}>
          저장
        </button>
      </div>
    </header>
  );
}

/** Shortcut help for the session, opened by ? or the toolbar. */
function EditHelp({ session }: { session: EditSession }) {
  const open = useEditState(session, (state) => state.help);
  return open ? <ShortcutHelp onClose={() => session.setHelp(false)} /> : null;
}

/** One home's island. Its runtime is this home's alone; mount it under a `key` per home. */
export default function Minihome({ view, viewer, viewerMinime, minimes, studioItems, editing, onView }: MinihomeProps) {
  const { profile, isOwner } = view;
  const navigate = useNavigate();
  const [saved, setSaved] = useState(false);
  // The island's runtime and, around it, its saving, undo history and (for the owner) decorating session.
  const [world] = useState(() => {
    const adapter = createHomeSaveAdapter({ username: profile.username, worldId: MINIHOME_WORLD_ID, writable: isOwner });
    const runtime = createMinihomeRuntime(adapter, (error, context) => console.error(`[island ${context.source}]`, error));
    const saver = createIslandSaver({ system: runtime.save, adapter, writable: isOwner });
    const history = createEditHistory(runtime.buildingStore);
    const labels = new Map(studioItems.map((item) => [item.id, item.label]));
    const session = isOwner ? createEditSession(runtime, history, labels) : null;
    return { runtime, saver, history, session };
  });
  const { runtime, saver, session } = world;
  useEffect(() => {
    const { history } = world;
    let alive = true;
    // Undo starts from the loaded island, never from the village the runtime begins with.
    runtime
      .setup()
      .then(() => (alive ? saver.load() : false))
      .then((loaded) => {
        if (loaded && alive) history.start();
      })
      .catch((error: unknown) => console.error(error));
    const unwatch = runtime.buildingStore.subscribe((state, previous) => {
      if (!sameParts(readParts(state), readParts(previous))) saver.changed();
    });
    // Rule flags (a chat's choices) change outside the building store; a slow look catches them.
    const poll = window.setInterval(saver.changed, 5000);
    return () => {
      alive = false;
      unwatch();
      window.clearInterval(poll);
      // Leaving the page in the app (another island, 둘러보기) keeps unsaved edits: save them, then let the world go.
      const pending = saver.flush();
      saver.dispose();
      history.stop();
      world.session?.dispose();
      void pending.finally(() => runtime.dispose().catch((error: unknown) => console.error(error)));
    };
  }, [world, runtime, saver]);
  const saverState = useSaver(saver);
  const editActive = useEditState(session, (state) => state.active);

  const [settings, setSettings] = useStored<SceneSettings>('scene', {
    quality: 'auto',
    postProcessing: false,
    idleThrottle: true,
  });
  // On a phone, upright or on its side, the panel covers most of the world, so it starts folded there.
  const [panelOpen, setPanelOpen] = useStored<boolean>('panel', !matchMedia('(max-width: 720px), (max-height: 500px)').matches);
  const [tab, setTab] = useState<PanelTab>('guestbook');
  const [bgm, setBgm] = useState(false);
  const [performance, setPerformance] = useState(false);
  const neighbors = useNeighbors(view, viewer);
  const decorating = editing && isOwner;
  const characterUrl = minimes.find((item) => item.id === viewerMinime)?.modelUrl ?? modelUrl('man');
  const urls = useMemo(() => ({ characterUrl }), [characterUrl]);
  const playerRef = useRef<RapierRigidBody>(null!);
  const changeSettings = useCallback(
    (next: Partial<SceneSettings>) => setSettings((current) => ({ ...current, ...next })),
    [setSettings],
  );
  const updateProfile = useCallback(
    (changes: ProfileChanges) => {
      homeApi.update(changes).then(onView, (error: unknown) => console.error(error));
    },
    [onView],
  );
  const home = `/@${profile.username}`;
  const save = useCallback(
    () =>
      saver.save().then((ok) => {
        if (ok) setSaved(true);
        return ok;
      }),
    [saver],
  );
  const saveNow = useCallback(() => void save(), [save]);
  // Leaving saves first; with nothing unsaved (or nothing that can be saved yet) it just leaves.
  const exit = () => {
    const state = saver.getState();
    if (state.phase !== 'ready' || (!state.dirty && !state.saving)) navigate(home);
    else void save().then((ok) => ok && navigate(home));
  };
  useEffect(() => {
    if (!saved) return undefined;
    const timer = setTimeout(() => setSaved(false), 2200);
    return () => clearTimeout(timer);
  }, [saved]);
  // Finishing decorating saves what is left, rather than waiting for the autosave.
  useEffect(() => {
    if (!decorating) return undefined;
    return () => void saver.flush();
  }, [decorating, saver]);
  // Hiding the tab saves; closing or reloading it with edits still unsaved asks first.
  const unsaved = decorating && (saverState.dirty || saverState.saving);
  useEffect(() => {
    if (!isOwner) return undefined;
    const hidden = () => {
      if (document.visibilityState === 'hidden') void saver.flush();
    };
    const leaving = (event: BeforeUnloadEvent) => {
      void saver.flush();
      if (unsaved) event.preventDefault();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', saver.flush);
    window.addEventListener('beforeunload', leaving);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', saver.flush);
      window.removeEventListener('beforeunload', leaving);
    };
  }, [isOwner, saver, unsaved]);
  const resetIsland = () => runtime.buildingStore.getState().hydrate(createVillage());
  const reloaded = () => {
    world.history.stop();
    world.history.start();
  };

  return (
    <GaesupWorld runtime={runtime} urls={urls} cameraOption={CAMERA}>
      <Bgm enabled={bgm} />
      <CameraOcclusion fade={settings.cameraFade ?? true} />
      <LiveRoom username={profile.username} viewer={viewer} characterUrl={characterUrl} playerRef={playerRef}>
        <div className={`mg-world${decorating ? ' is-editing' : ''}${panelOpen ? ' has-panel' : ''}`}>
          <div className="mg-world-canvas">
            {/* The canvas reads the decorating session for its in-world tools (R3F bridges the context). */}
            <EditContext.Provider value={decorating ? session : null}>
              <Scene {...settings} playerRef={playerRef} visitors={<LiveAvatars playerRef={playerRef} />} />
            </EditContext.Provider>
          </div>
          <WorldLoading />

          {decorating && session ? (
            <>
              <EditBar view={view} session={session} saver={saver} onSave={saveNow} onExit={exit} />
              <Rail />
              {saverState.phase === 'ready' || editActive ? (
                <Decorate session={session} studioItems={studioItems} onReset={resetIsland} />
              ) : (
                <p className="mg-edit-wait mg-glass" role="status">
                  {saverState.phase === 'loading' ? '섬을 불러오는 중이에요. 다 불러오면 꾸밀 수 있어요.' : '섬을 불러와야 꾸밀 수 있어요.'}
                </p>
              )}
              <EditHelp session={session} />
            </>
          ) : (
            <>
              <header className="mg-topbar">
                <div className="mg-topbar-left">
                  <Brand />
                  <IslandPill view={view} minimes={minimes} />
                  <TimeChip />
                </div>
                <TopActions>
                  <SettingsMenu settings={settings} onChange={changeSettings} bgm={bgm} onBgm={setBgm} onPerformance={() => setPerformance(true)} />
                </TopActions>
              </header>
              <Rail />

              {panelOpen ? (
                <aside className="mg-side mg-glass" aria-label={`${profile.ownerName}의 섬`}>
                  <button className="mg-icon-btn is-quiet mg-side-close" aria-label="패널 접기" onClick={() => setPanelOpen(false)}>
                    <Icon name="chevronRight" />
                  </button>
                  <ProfileHeader
                    view={view}
                    minimes={minimes}
                    neighbors={neighbors.list.length}
                    onEdit={() => setTab('about')}
                  />
                  <div className="mg-tabs" role="tablist" aria-label="섬 이야기">
                    {PANEL_TABS.map((item) => (
                      <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
                        {item.label}
                        {item.id === 'neighbors' && neighbors.received.length > 0 && <span className="mg-badge is-paid">{neighbors.received.length}</span>}
                      </button>
                    ))}
                  </div>
                  <div className="mg-side-body" role="tabpanel">
                    {tab === 'guestbook' && <Guestbook username={profile.username} viewer={viewer} />}
                    {tab === 'neighbors' && <NeighborsTab view={view} viewer={viewer} neighbors={neighbors} />}
                    {tab === 'about' && <About view={view} minimes={minimes} onUpdate={updateProfile} />}
                  </div>
                </aside>
              ) : (
                <button className="mg-btn mg-side-open" onClick={() => setPanelOpen(true)}>
                  <span className="mg-avatar is-round" data-tone={toneOf(profile.username)}>
                    {initialOf(profile.ownerName)}
                  </span>
                  {profile.ownerName}의 섬 이야기
                </button>
              )}

              <div className="mg-world-bottom">
                <ChatBar signedIn={!!viewer} />
                <KeyHints keys={KEYS} />
                <KeyHints keys={TOUCH_KEYS} touch />
              </div>
              {performance && <StatusPanel onClose={() => setPerformance(false)} />}
            </>
          )}

          {saved && (
            <p className="mg-toast mg-glass" role="status">
              <Icon name="check" /> 섬을 저장했어요
            </p>
          )}
          <SaveBanners saver={saver} editing={decorating} onReloaded={reloaded} />
          <InteractionPrompt enabled={!decorating} />
          <DialogBox />
          <ToastHost position="top-center" />
        </div>
      </LiveRoom>
    </GaesupWorld>
  );
}
