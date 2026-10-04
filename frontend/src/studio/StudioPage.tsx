import './studio.css';

import { lazy, Suspense, useLayoutEffect, useState, type ReactNode } from 'react';

import { Link, Navigate, useLocation } from 'react-router-dom';

import { useStudioSleep, type StudioSleep } from '../api/studioSleep';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/can';
import { SignInRedirect } from '../auth/signIn';
import { AdminTabs } from '../pages/AdminTabs';
import { Loading } from '../pages/Loading';
import { PageShell } from '../shell/Shell';
import { routeOf, studioSections, type Screen, type Section } from './screens';
import { StudioPowerLine, StudioWaking } from './StudioPower';
import { FactoryUsageContext, useFactoryUsage } from './usage';

// The character studio's own screens (src/character), mounted as they are.
const Workspace = lazy(() => import('../character/studio/Workspace').then((module) => ({ default: module.Workspace })));

/**
 * The pathname selects the screen. Legacy query state is supplied once before the workspace mounts.
 */
function WorkspaceFrame({ screen }: { screen: Screen }) {
  const { pathname, search } = useLocation();
  const entry = `${pathname}${search}`;
  const [ready, setReady] = useState<string | null>(null);
  useLayoutEffect(() => {
    const query = new URLSearchParams(search);
    query.set('tab', screen.tab);
    if (screen.mode) query.set('mode', screen.mode);
    else query.delete('mode');
    history.replaceState(history.state, '', `${pathname}?${query}${location.hash}`);
    setReady(entry);
  }, [entry, pathname, search, screen]);
  return ready === entry ? <Workspace key={entry} /> : null;
}

/** The studio's screens on the app's page, scoped so their stylesheets stay inside. */
export function Stage({ children }: { children: ReactNode }) {
  return (
    <div className="studio-root mg-studio-stage">
      <Suspense fallback={<p className="mg-empty">스튜디오를 여는 중…</p>}>{children}</Suspense>
    </div>
  );
}

const ACCESS = { read: '읽기만', write: '기록 바꾸기까지', paid: '유료 작업까지' } as const;

/**
 * For admins: whether the character server is connected here and how far the screens may go, as last read. A read
 * that got no answer shows as unread, never as a server that is not connected.
 */
function Connection({ usage, failed, refresh }: ReturnType<typeof useFactoryUsage>) {
  if (!usage && !failed) return null;
  const known = failed ? null : usage;
  return (
    <section className="mg-studio-connection">
      <p role="status">
        <i className={`mg-dot${known?.connected ? ' is-good' : ''}`} />
        {!known ? '캐릭터 서버 상태를 읽지 못함' : known.connected ? `캐릭터 서버 · ${ACCESS[known.access]}` : '캐릭터 서버 연결 안 됨'}
      </p>
      {!known && (
        <button type="button" className="mg-btn is-small" onClick={refresh}>
          다시 확인
        </button>
      )}
      {known?.connected && known.access === 'paid' && (
        <small>
          이번 달 유료 작업 {known.paidThisMonth} / {known.paidMonthly}
        </small>
      )}
      {known?.connected && known.access !== 'paid' && <small>비용이 드는 작업은 이 서버에서 막혀 있어요</small>}
      {usage?.connected && <StudioPowerLine canStart />}
    </section>
  );
}

/**
 * `/admin/studio/*`: the character factory, for operators only (members dress their character at `/character`). Paid
 * screens show only to paid operators; the server's permissions and FACTORY_ACCESS still decide every request.
 */
export default function StudioPage() {
  const { status, user } = useAuth();
  const { pathname, search, hash } = useLocation();
  const sleep = useStudioSleep();
  if (status === 'loading') return <Loading />;
  if (!user) return <SignInRedirect />;
  if (!can(user, 'operator')) return <Navigate to="/character" replace />;
  const sections = studioSections(can(user, 'paid_operator'));
  const screen = sections.flatMap((section) => section.screens).find((item) => pathname === item.path);
  if (!screen) {
    const legacy = pathname === '/admin/studio' ? routeOf(`/${search}`) : null;
    const allowed = legacy && sections.some((section) => section.screens.some((item) => item.path === legacy.split('?')[0]));
    return <Navigate to={allowed ? `${legacy}${hash}` : sections[0]!.screens[0]!.path} replace />;
  }
  return <Studio sections={sections} screen={screen} pathname={pathname} sleep={sleep} />;
}

/** The menu and the stage, for an operator. The usage it reads also tells the screens whether paid work is open here. */
function Studio({ sections, screen, pathname, sleep }: { sections: Section[]; screen: Screen; pathname: string; sleep: StudioSleep | null }) {
  const usage = useFactoryUsage();
  return (
    <PageShell title="운영" wide>
      <section className="mg-glass mg-panel mg-studio-head">
        <div className="mg-panel-head">
          <h1 className="mg-title">운영</h1>
          <AdminTabs />
        </div>
      </section>
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
          <Connection {...usage} />
        </nav>
        <FactoryUsageContext.Provider value={usage.usage}>
          <Stage>
            {/* While the studio sleeps its screens stay closed; they open afresh once it answers. */}
            {sleep ? <StudioWaking sleep={sleep} member={false} /> : <WorkspaceFrame screen={screen} />}
          </Stage>
        </FactoryUsageContext.Provider>
      </div>
    </PageShell>
  );
}
