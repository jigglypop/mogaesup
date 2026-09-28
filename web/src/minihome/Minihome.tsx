import './minihome.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { RapierRigidBody } from '@react-three/rapier';

import { Link } from 'react-router-dom';
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
} from 'gaesup-world';

import { homeApi } from '../api/endpoints';
import type { CatalogItem, HomeView, ProfileChanges, User } from '../api/types';
import { Decorate } from './Decorate';
import { Guestbook } from './Guestbook';
import { LiveAvatars, LiveBar, LiveRoom } from './live';
import { createHomeSaveAdapter, isSaveConflict } from './persistence';
import { Profile } from './Profile';
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

type Tab = 'home' | 'decorate' | 'guestbook';
const KEYS = [
  ['WASD', '이동'],
  ['클릭', '가기'],
  ['드래그', '시점'],
  ['Shift', '달리기'],
  ['Space', '점프'],
  ['E', '대화'],
] as const;

function Clock() {
  const time = useGameTime();
  const day = time.hour >= 6 && time.hour < 18;
  return (
    <span className="mh-chip">
      {day ? '☀️' : '🌙'} {String(time.hour).padStart(2, '0')}:{String(time.minute).padStart(2, '0')}
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

export type MinihomeProps = {
  view: HomeView;
  viewer: User | null;
  /** The 미니미 the viewer walks the island as: the owner's own, or the visitor's. */
  viewerMinime: string;
  minimes: CatalogItem[];
  onView: (view: HomeView) => void;
  onLogout: () => void;
};

/** One home's minihome. Its runtime is this home's alone; mount it under a `key` per home. */
export default function Minihome({ view, viewer, viewerMinime, minimes, onView, onLogout }: MinihomeProps) {
  const { profile, visits, isOwner } = view;
  const [conflict, setConflict] = useState(false);
  const [runtime] = useState(() =>
    createMinihomeRuntime(
      createHomeSaveAdapter({ username: profile.username, worldId: MINIHOME_WORLD_ID, writable: isOwner }),
      (error, context) => {
        if (isSaveConflict(error)) setConflict(true);
        else console.error(`[minihome ${context.source}]`, error);
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
  const [tab, setTab] = useState<Tab>('home');
  const [bgm, setBgm] = useState(false);
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
  const resetIsland = () => runtime.buildingStore.getState().hydrate(createVillage());
  // A finished room is saved at once rather than at the next autosave.
  const finishDecorating = () => {
    runtime.save.save().catch((error: unknown) => (isSaveConflict(error) ? setConflict(true) : console.error(error)));
    setTab('home');
  };
  const tabs: { id: Tab; label: string }[] = [
    { id: 'home', label: '홈' },
    ...(isOwner ? [{ id: 'decorate' as const, label: '꾸미기' }] : []),
    { id: 'guestbook', label: '방명록' },
  ];

  return (
    <GaesupWorld runtime={runtime} urls={urls} cameraOption={CAMERA}>
      <Persistence autosave={isOwner && !conflict} />
      <Bgm enabled={bgm} />
      <LiveRoom username={profile.username} viewer={viewer} characterUrl={characterUrl} playerRef={playerRef}>
        <div className="mh-page">
          <div className="mh-frame">
            <header className="mh-head">
              <div className="mh-counter">
                TODAY <b>{visits.today.toLocaleString()}</b>
                <span>|</span>
                TOTAL <b>{visits.total.toLocaleString()}</b>
              </div>
              <h1>
                {profile.title}
                <small>@{profile.username}</small>
              </h1>
              <div className="mh-head-actions">
                <Link className="mh-chip-button" to="/explore">
                  둘러보기
                </Link>
                {viewer && !isOwner && (
                  <Link className="mh-chip-button" to={`/@${viewer.username}`}>
                    내 미니홈피
                  </Link>
                )}
                {viewer?.role === 'admin' && (
                  <Link className="mh-chip-button" to="/admin">
                    관리
                  </Link>
                )}
                <button className="mh-chip-button" aria-pressed={bgm} onClick={() => setBgm(!bgm)}>
                  {bgm ? '🔊 BGM 켜짐' : '🔈 BGM 꺼짐'}
                </button>
                {viewer ? (
                  <button className="mh-chip-button" onClick={onLogout}>
                    로그아웃
                  </button>
                ) : (
                  <Link className="mh-chip-button" to="/">
                    로그인
                  </Link>
                )}
              </div>
            </header>

            <div className="mh-body">
              <aside className="mh-side">
                <Profile view={view} viewer={viewer} minimes={minimes} onUpdate={updateProfile} />
              </aside>

              <main className="mh-stage">
                <div className="mh-canvas">
                  <Scene {...settings} playerRef={playerRef} visitors={<LiveAvatars playerRef={playerRef} />} />
                </div>
                <WorldLoading />
                <div className="mh-hud">
                  <div className="mh-hud-top">
                    <Clock />
                    <span className="mh-chip">🏝️ {profile.ownerName}의 섬</span>
                    {!isOwner && <span className="mh-chip">방문 중</span>}
                  </div>
                  {tab === 'home' && <LiveBar />}
                  {tab !== 'decorate' && (
                    <div className="mh-keys">
                      {KEYS.map(([key, label]) => (
                        <span key={key}>
                          <kbd>{key}</kbd>
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {conflict && (
                  <div className="mh-conflict" role="alert">
                    <span>다른 곳에서 섬을 먼저 저장했어요. 여기서 꾸민 내용은 저장되지 않아요.</span>
                    <button className="mh-done" onClick={() => window.location.reload()}>
                      새로 불러오기
                    </button>
                  </div>
                )}
                <InteractionPrompt enabled={tab === 'home'} />
                <DialogBox />
                <ToastHost position="top-center" />
                {tab === 'decorate' && isOwner && <Decorate onDone={finishDecorating} onReset={resetIsland} />}
                {tab === 'guestbook' && (
                  <Guestbook username={profile.username} viewer={viewer} onClose={() => setTab('home')} />
                )}
              </main>

              <nav className="mh-tabs" aria-label="미니홈피 메뉴">
                {tabs.map((item) => (
                  <button
                    key={item.id}
                    aria-current={tab === item.id ? 'page' : undefined}
                    onClick={() => setTab(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>

              <aside className="mh-panel">
                <StatusPanel settings={settings} onChange={changeSettings} />
              </aside>
            </div>
          </div>
        </div>
      </LiveRoom>
    </GaesupWorld>
  );
}
