import './minihome.css';

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
  useAutoSave,
  useGameTime,
  useLoadOnMount,
  type WorldQuality,
} from 'gaesup-world';
import { useBuildingStoreApi } from 'gaesup-world/building';

import { homeApi } from '../api/endpoints';
import type { CatalogItem, HomeView, ProfileChanges, User } from '../api/types';
import { Brand, initialOf, Rail, toneOf, TopActions, usePopover } from '../shell/Shell';
import { Icon } from '../ui/icons';
import { Decorate, useBuildingHistory } from './Decorate';
import { Guestbook } from './Guestbook';
import { NeighborsTab, useNeighbors } from './Ilchons';
import { ChatBar, LiveAvatars, LiveRoom, usePresence } from './live';
import { createHomeSaveAdapter, isSaveConflict } from './persistence';
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
  ['E', '대화'],
] as const;
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

/** Loads the island once and, for its owner, keeps saving it; lives under the world so it uses this runtime's save system. */
function Persistence({ autosave }: { autosave: boolean }) {
  useLoadOnMount();
  useAutoSave({ enabled: autosave, intervalMs: 60_000 });
  return null;
}

function Bgm({ enabled }: { enabled: boolean }) {
  useAmbientBgm(enabled);
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

function EditBar({ view, onSave, onExit }: { view: HomeView; onSave: () => void; onExit: () => void }) {
  const store = useBuildingStoreApi();
  const history = useBuildingHistory(store);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) history.undo();
      else if ((key === 'z' && event.shiftKey) || key === 'y') history.redo();
      else if (key === 's') onSave();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [history, onSave]);
  return (
    <header className="mg-topbar">
      <div className="mg-topbar-left">
        <Brand />
        <span className="mg-pill mg-glass">
          {view.profile.title}
          <span className="mg-badge is-draft">꾸미는 중</span>
        </span>
      </div>
      <div className="mg-topbar-right">
        <span className="mg-pill mg-glass mg-undo">
          <button className="mg-icon-btn is-quiet" aria-label="되돌리기" disabled={!history.canUndo} onClick={history.undo}>
            <Icon name="undo" />
          </button>
          <button className="mg-icon-btn is-quiet" aria-label="다시 하기" disabled={!history.canRedo} onClick={history.redo}>
            <Icon name="redo" />
          </button>
        </span>
        <button className="mg-btn" onClick={onExit}>
          나가기
        </button>
        <button className="mg-btn is-primary" onClick={onSave}>
          저장
        </button>
      </div>
    </header>
  );
}

/** One home's island. Its runtime is this home's alone; mount it under a `key` per home. */
export default function Minihome({ view, viewer, viewerMinime, minimes, studioItems, editing, onView }: MinihomeProps) {
  const { profile, isOwner } = view;
  const navigate = useNavigate();
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [runtime] = useState(() =>
    createMinihomeRuntime(
      createHomeSaveAdapter({ username: profile.username, worldId: MINIHOME_WORLD_ID, writable: isOwner }),
      (error, context) => {
        if (isSaveConflict(error)) setConflict(true);
        else console.error(`[island ${context.source}]`, error);
      },
    ),
  );
  useEffect(() => {
    runtime.setup().catch((error: unknown) => console.error(error));
    return () => {
      runtime.dispose().catch((error: unknown) => console.error(error));
    };
  }, [runtime]);

  const [settings, setSettings] = useStored<SceneSettings>('scene', {
    quality: 'auto',
    postProcessing: false,
    idleThrottle: true,
  });
  // On a phone the panel covers most of the world, so it starts folded there.
  const [panelOpen, setPanelOpen] = useStored<boolean>('panel', !matchMedia('(max-width: 720px)').matches);
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
      runtime.save.save().then(
        () => {
          setSaved(true);
          return true;
        },
        (error: unknown) => {
          if (isSaveConflict(error)) setConflict(true);
          else console.error(error);
          return false;
        },
      ),
    [runtime],
  );
  useEffect(() => {
    if (!saved) return undefined;
    const timer = setTimeout(() => setSaved(false), 2200);
    return () => clearTimeout(timer);
  }, [saved]);
  const resetIsland = () => runtime.buildingStore.getState().hydrate(createVillage());

  return (
    <GaesupWorld runtime={runtime} urls={urls} cameraOption={CAMERA}>
      <Persistence autosave={isOwner && !conflict} />
      <Bgm enabled={bgm} />
      <LiveRoom username={profile.username} viewer={viewer} characterUrl={characterUrl} playerRef={playerRef}>
        <div className={`mg-world${decorating ? ' is-editing' : ''}${panelOpen ? ' has-panel' : ''}`}>
          <div className="mg-world-canvas">
            <Scene {...settings} playerRef={playerRef} visitors={<LiveAvatars playerRef={playerRef} />} />
          </div>
          <WorldLoading />

          {decorating ? (
            <>
              <EditBar view={view} onSave={() => void save()} onExit={() => void save().then((ok) => ok && navigate(home))} />
              <Rail />
              <Decorate studioItems={studioItems} onReset={resetIsland} />
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
                <div className="mg-keys" aria-label="조작">
                  {KEYS.map(([key, label]) => (
                    <span key={key} className="mg-kbd">
                      <kbd>{key}</kbd>
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              {performance && <StatusPanel onClose={() => setPerformance(false)} />}
            </>
          )}

          {saved && (
            <p className="mg-toast mg-glass" role="status">
              <Icon name="check" /> 섬을 저장했어요
            </p>
          )}
          {conflict && (
            <div className="mg-conflict mg-glass" role="alert">
              <span>다른 곳에서 섬을 먼저 저장했어요. 여기서 꾸민 내용은 저장되지 않아요.</span>
              <button className="mg-btn is-primary is-small" onClick={() => window.location.reload()}>
                새로 불러오기
              </button>
            </div>
          )}
          <InteractionPrompt enabled={!decorating} />
          <DialogBox />
          <ToastHost position="top-center" />
        </div>
      </LiveRoom>
    </GaesupWorld>
  );
}
