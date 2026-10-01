import './studio.css';

import { lazy, Suspense, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';

import { Link, Navigate, useLocation } from 'react-router-dom';

import { catalogApi } from '../api/endpoints';
import { useStudioSleep } from '../api/studioSleep';
import type { FactoryUsage } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/can';
import { AdminTabs } from '../pages/AdminTabs';
import { Loading } from '../pages/Loading';
import { PageShell } from '../shell/Shell';
import { retargetStudioLink, studioSections, type Screen } from './screens';
import { StudioPowerLine, StudioWaking } from './StudioPower';

// The character studio's own screens (src/character), mounted as they are.
const Workspace = lazy(() => import('../character/studio/Workspace').then((module) => ({ default: module.Workspace })));

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
    query.set('tab', screen.tab);
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

/** The studio's screens on the app's page, scoped so their stylesheets stay inside. */
export function Stage({ children }: { children: ReactNode }) {
  useEffect(() => {
    // Links the studio writes for its own page (`/?tab=prompts…`) go to the matching route here, in its dialogs too.
    document.addEventListener('click', retargetStudioLink, true);
    document.addEventListener('auxclick', retargetStudioLink, true);
    return () => {
      document.removeEventListener('click', retargetStudioLink, true);
      document.removeEventListener('auxclick', retargetStudioLink, true);
    };
  }, []);
  return (
    <div className="studio-root mg-studio-stage">
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
      {usage.connected && <StudioPowerLine />}
    </section>
  );
}

/**
 * `/admin/studio/*`: the character factory, for operators only (members dress their character at `/character`). Paid
 * screens show only to paid operators; the server's permissions and FACTORY_ACCESS still decide every request.
 */
export default function StudioPage() {
  const { status, user } = useAuth();
  const { pathname } = useLocation();
  const sleep = useStudioSleep();
  if (status === 'loading') return <Loading />;
  if (!user) return <Navigate to="/" replace />;
  if (!can(user, 'operator')) return <Navigate to="/character" replace />;
  const sections = studioSections(can(user, 'paid_operator'));
  const screen = sections.flatMap((section) => section.screens).find((item) => pathname === item.path);
  if (!screen) return <Navigate to={sections[0]!.screens[0]!.path} replace />;

  return (
    <PageShell title="캐릭터 공장" wide>
      <AdminTabs />
      <div className="mg-studio">
        <nav className="mg-studio-nav mg-glass" aria-label="캐릭터 공장">
          {sections.map((section) => (
            <section key={section.title}>
              <p>{section.title}</p>
              {section.screens.map((item) => (
                <Link key={item.path} to={item.path} aria-current={pathname === item.path ? 'page' : undefined}>
                  <span>{item.label}</span>
                  {item.paid && <span className="mg-badge is-paid">유료</span>}
                </Link>
              ))}
            </section>
          ))}
          <Connection />
        </nav>
        <Stage>
          {/* While the studio sleeps its screens stay closed; they open afresh once it answers. */}
          {sleep ? <StudioWaking sleep={sleep} member={false} /> : <WorkspaceFrame screen={screen} />}
        </Stage>
      </div>
    </PageShell>
  );
}
