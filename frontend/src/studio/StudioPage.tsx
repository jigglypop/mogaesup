import './studio.css';

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { Link, Navigate, useLocation } from 'react-router-dom';

import { catalogApi } from '../api/endpoints';
import type { FactoryUsage } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { Loading } from '../pages/Loading';
import { PageShell } from '../shell/Shell';
import { Icon } from '../ui/icons';

// The studio's own screens (the gaesup-character submodule's frontend, a workspace package), mounted as they are.
const Wardrobe = lazy(() => import('character-wardrobe-ui/wardrobe'));
const Workspace = lazy(() => import('character-wardrobe-ui/workspace').then((module) => ({ default: module.Workspace })));

type Screen = { path: string; label: string; tab?: string; mode?: string; paid?: boolean };
type Section = { title: string; locked: boolean; screens: Screen[] };

/** Each route and the studio screen (its `tab` and `mode` query) it shows. */
const MAKE: Screen[] = [
  { path: '/studio/make/photo', label: '사진으로 전체 생성', tab: 'character', mode: 'photo', paid: true },
  { path: '/studio/make/body', label: '기본몸', tab: 'character', mode: 'body' },
  { path: '/studio/make/parts', label: '파츠', tab: 'character', mode: 'parts' },
  { path: '/studio/assets/animals', label: '동물', tab: 'animals', paid: true },
  { path: '/studio/assets/props', label: '기물', tab: 'props', paid: true },
  { path: '/studio/assets/textures', label: '바닥 타일', tab: 'textures' },
  { path: '/studio/assets/emoticons', label: '2D 이모티콘', tab: 'emoticons', paid: true },
];
const MANAGE: Screen[] = [
  { path: '/studio/library', label: '에셋 라이브러리', tab: 'admin' },
  { path: '/studio/prompts', label: '프롬프트', tab: 'prompts' },
];
const WORKSPACE_SCREENS = [...MAKE, ...MANAGE];

/** The studio links to its own screens as `/?tab=…`; these are the app's routes for them. */
function routeOf(href: string): string | null {
  if (!href.startsWith('/?')) return null;
  const query = new URLSearchParams(href.slice(2));
  const tab = query.get('tab');
  const mode = query.get('mode');
  const screen = WORKSPACE_SCREENS.find((item) => item.tab === tab && (!item.mode || !mode || item.mode === mode));
  if (!screen) return null;
  query.delete('tab');
  query.delete('mode');
  const rest = query.toString();
  return rest ? `${screen.path}?${rest}` : screen.path;
}

/**
 * Hosts the studio's workspace on an app route. The workspace keeps its screen in the query string, reads it once when it
 * mounts and rewrites the address as `/?…`; here the address stays on this route and the route picks the screen.
 */
function WorkspaceFrame({ screen }: { screen: Screen }) {
  const { pathname } = useLocation();
  const [ready, setReady] = useState<string | null>(null);
  useLayoutEffect(() => {
    const original = history.replaceState;
    const keep = (url: string | URL | null | undefined) =>
      typeof url === 'string' && url.startsWith('/?') ? `${pathname}${url.slice(1)}` : url;
    history.replaceState = function replaceState(data, unused, url) {
      // The router keeps its own entry state; the studio writes null over it.
      return original.call(this, data ?? history.state, unused, keep(url));
    };
    const query = new URLSearchParams(location.search);
    query.set('tab', screen.tab!);
    if (screen.mode) query.set('mode', screen.mode);
    else query.delete('mode');
    original.call(history, history.state, '', `${pathname}?${query}`);
    setReady(screen.path);
    return () => {
      history.replaceState = original;
    };
  }, [pathname, screen]);
  return ready === screen.path ? <Workspace key={screen.path} /> : null;
}

/** The studio's screens, dark glass, scoped so their stylesheets stay inside. */
function Stage({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    // Links the studio writes for its own page (`/?tab=prompts…`) go to the matching route here.
    const retarget = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href^="/?"]');
      const route = anchor ? routeOf(anchor.getAttribute('href') ?? '') : null;
      if (anchor && route) anchor.setAttribute('href', route);
    };
    element.addEventListener('click', retarget, true);
    element.addEventListener('auxclick', retarget, true);
    return () => {
      element.removeEventListener('click', retarget, true);
      element.removeEventListener('auxclick', retarget, true);
    };
  }, []);
  return (
    <div ref={ref} className="studio-root mg-dark mg-studio-stage mg-glass">
      <Suspense fallback={<p className="mg-empty">스튜디오를 여는 중…</p>}>{children}</Suspense>
    </div>
  );
}

const ACCESS = { read: '읽기만', write: '기록 바꾸기까지', paid: '유료 작업까지' } as const;

/** For admins: whether the character server is connected here and how far the screens may go. */
function Connection() {
  const [usage, setUsage] = useState<FactoryUsage | null>(null);
  useEffect(() => {
    catalogApi.factoryUsage().then(setUsage, () => setUsage({ connected: false }));
  }, []);
  if (!usage) return null;
  return (
    <section className="mg-studio-connection">
      <p>
        <i className={`mg-dot${usage.connected ? ' is-good' : ''}`} />
        {usage.connected ? `캐릭터 서버 · ${ACCESS[usage.access]}` : '캐릭터 서버 연결 안 됨'}
      </p>
      {usage.connected && usage.access === 'paid' && (
        <small>
          이번 달 유료 작업 {usage.paidThisMonth} / {usage.paidMonthly}
        </small>
      )}
      {usage.connected && usage.access !== 'paid' && <small>비용이 드는 작업은 이 서버에서 막혀 있어요</small>}
    </section>
  );
}

function Locked() {
  return (
    <div className="mg-studio-locked">
      <Icon name="lock" />
      <b>운영자만 쓰는 화면이에요</b>
      <p className="mg-muted">캐릭터와 기물을 만드는 작업은 비용이 들어서 운영자만 열 수 있어요.</p>
      <Link className="mg-btn is-primary" to="/studio">
        옷장으로
      </Link>
    </div>
  );
}

/** `/studio/*`: the character studio inside the app. Everyone dresses their character; admins also make and manage. */
export default function StudioPage() {
  const { status, user } = useAuth();
  const { pathname } = useLocation();
  if (status === 'loading') return <Loading />;
  if (!user) return <Navigate to="/" replace />;
  const admin = user.role === 'admin';
  const sections: Section[] = [
    { title: '내 캐릭터', locked: false, screens: [{ path: '/studio', label: '옷장' }] },
    { title: '만들기', locked: !admin, screens: MAKE },
    { title: '관리', locked: !admin, screens: MANAGE },
  ];
  const screen = WORKSPACE_SCREENS.find((item) => pathname === item.path);
  const wardrobe = pathname === '/studio' || pathname === '/studio/';
  if (!screen && !wardrobe) return <Navigate to="/studio" replace />;

  return (
    <PageShell title="캐릭터" wide>
      <div className="mg-studio">
        <nav className="mg-studio-nav mg-glass" aria-label="캐릭터 스튜디오">
          {sections.map((section) => (
            <section key={section.title}>
              <p>
                {section.title}
                {section.locked && <Icon name="lock" />}
              </p>
              {section.screens.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  aria-current={pathname === item.path || (item.path === '/studio' && wardrobe) ? 'page' : undefined}
                  className={section.locked ? 'is-locked' : undefined}
                >
                  <span>{item.label}</span>
                  {item.paid && <span className="mg-badge is-paid">유료</span>}
                </Link>
              ))}
            </section>
          ))}
          {admin && <Connection />}
        </nav>
        <Stage>{wardrobe ? <Wardrobe /> : !admin ? <Locked /> : screen && <WorkspaceFrame screen={screen} />}</Stage>
      </div>
    </PageShell>
  );
}
