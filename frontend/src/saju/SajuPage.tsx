import './saju.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';
import { PageShell } from '../shell/Shell';
import { Icon } from '../ui/icons';
import { compatOf } from './compat';
import type { Element } from './elements';
import { melodyOf } from './melody';
import { profileOf, type Profile } from './profile';
import { MY_HOME, SAMPLE_RESIDENTS, type Resident } from './residents';
import { chartPath, homePath, nextWave, routeOf, SAJU, VILLAGE } from './routes';
import { frameOf } from './scene/frames';
import { Stage, type StageBridge, type StageHome } from './scene/Stage';
import { entriesOf, residentsOf, useSaju } from './store';
import { Bgm } from './ui/Bgm';
import { ChartPanel } from './ui/ChartPanel';
import { HomePanel, type BridgeState } from './ui/HomePanel';
import { Onboarding } from './ui/Onboarding';
import { PixelIcon } from './ui/PixelIcon';
import { SavePicture } from './ui/SavePicture';
import { VillagePanel } from './ui/VillagePanel';
import { plotsOf } from './village';

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** A resident's profile, or null for a stored birth this version can no longer read. */
function profileOrNull(resident: Resident): Profile | null {
  try {
    return profileOf(resident.birth);
  } catch {
    return null;
  }
}

/**
 * `/saju/*`: the 사주 village. One frame, a 미니홈피: the village's canvas on one side, and beside it the story of
 * whatever the address shows: the viewer's own home (or the card to build it), a neighbour's, or everyone's.
 */
export default function SajuPage() {
  const { '*': rest = '' } = useParams();
  const { search } = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const state = useSaju();
  const route = routeOf(rest, search, !!state.me);

  // Everyone and what their chart gives. A line in a guestbook or a new bridge leaves these as they are, and with them
  // the homes the canvas draws.
  const people = useMemo(
    () => residentsOf(state.me).flatMap((resident) => {
      const profile = profileOrNull(resident);
      return profile ? [{ resident, profile }] : [];
    }),
    [state.me],
  );
  const me = useMemo(() => people.find(({ resident }) => resident.id === MY_HOME) ?? null, [people]);
  const neighbours = useMemo(() => people.filter(({ resident }) => resident.id !== MY_HOME), [people]);
  const homes = useMemo<StageHome[]>(() => {
    const plots = plotsOf(neighbours.map(({ resident, profile }) => ({ id: resident.id, element: profile.balance.dominant })));
    return [
      { id: MY_HOME, x: 0, z: 0, profile: me?.profile ?? null },
      ...plots.flatMap((plot) => {
        const neighbour = neighbours.find(({ resident }) => resident.id === plot.id);
        return neighbour ? [{ id: plot.id, x: plot.x, z: plot.z, profile: neighbour.profile }] : [];
      }),
    ];
  }, [me, neighbours]);
  const bridges = useMemo<StageBridge[]>(() => {
    const mine = homes[0];
    if (!me || !mine) return [];
    return state.bridges.flatMap((id) => {
      const to = homes.find((home) => home.id === id);
      if (!to?.profile) return [];
      const compat = compatOf(me.profile, to.profile);
      return [{ from: mine, to, compat, colors: [token(`--mg-${compat.from}`), token(`--mg-${compat.to}`)] as [string, string] }];
    });
  }, [homes, me, state.bridges]);

  const viewedId = route.kind === 'home' ? route.id : route.kind === 'mine' || route.kind === 'edit' ? MY_HOME : null;
  const viewed = viewedId ? (people.find(({ resident }) => resident.id === viewedId) ?? null) : null;
  // 다리 보기: the stage shows the viewer's home and this neighbour's together. It ends with the visit.
  const [bridgeShown, setBridgeShown] = useState(false);
  useEffect(() => setBridgeShown(false), [viewedId]);
  // Another page of the village starts at its top: the window on a phone, the story's own column on a wide screen.
  const side = useRef<HTMLElement>(null);
  useEffect(() => {
    (document.scrollingElement ?? document.documentElement).scrollTop = 0;
    if (side.current) side.current.scrollTop = 0;
  }, [rest]);
  const bridged = route.kind === 'home' && state.bridges.includes(route.id);

  const frame = useMemo(() => {
    const spot = (id: string) => homes.find((home) => home.id === id);
    if (!viewed || !viewedId) return frameOf(homes);
    const here = spot(viewedId);
    const mine = spot(MY_HOME);
    if (!here) return frameOf(homes);
    return bridgeShown && bridged && mine ? frameOf([mine, here]) : frameOf([here]);
  }, [homes, viewed, viewedId, bridgeShown, bridged]);

  const visit = useCallback((id: string) => navigate(homePath(id)), [navigate]);
  const elementOf = useCallback((author: string): Element | null => people.find(({ resident }) => resident.id === author)?.profile.balance.dominant ?? null, [people]);

  if (route.kind === 'redirect') return <Navigate to={route.to} replace />;

  const title = viewed ? `${viewed.resident.name}의 미니홈피` : '사주 마을';
  const element = viewed?.profile.balance.dominant ?? null;
  const chart = (route.kind === 'mine' || route.kind === 'home') && route.chart && !!viewed;
  const menuHome = viewedId && viewed ? viewedId : MY_HOME;
  const wave = nextWave(SAMPLE_RESIDENTS.map((resident) => resident.id), route.kind === 'home' ? route.id : null);
  const compat = route.kind === 'home' && me && viewed ? compatOf(me.profile, viewed.profile) : null;
  const bridge: BridgeState | null =
    route.kind !== 'home' || !viewed ? null : !me || !compat ? { kind: 'homeless' } : bridged ? { kind: 'built', compat, shown: bridgeShown } : { kind: 'open', compat };

  return (
    <PageShell title="사주 마을">
      <div className="mg-saju">
        <section className="mg-saju-frame mg-glass" data-element={element ?? undefined}>
          <header className="mg-saju-bar">
            <h1>
              <span className="mg-saju-bar-mark">
                <PixelIcon name={element ?? 'house'} size={20} />
              </span>
              <span className="mg-saju-bar-title">{title}</span>
              {viewed?.resident.sample && <span className="mg-badge">샘플</span>}
            </h1>
            <div className="mg-saju-bar-actions">
              {route.kind !== 'mine' && route.kind !== 'edit' && (
                <Link className="mg-btn is-small" to={SAJU}>
                  <Icon name="home" /> {state.me ? '내 집' : '내 집 짓기'}
                </Link>
              )}
              {wave && (
                <Link className="mg-btn is-small" to={homePath(wave)}>
                  <Icon name="wave" /> 파도타기
                </Link>
              )}
            </div>
          </header>
          <nav className="mg-saju-menu" aria-label="미니홈피 메뉴">
            <Link to={homePath(menuHome)} aria-current={(route.kind === 'mine' || route.kind === 'home' || route.kind === 'edit') && !chart ? 'page' : undefined}>
              홈
            </Link>
            <Link to={chartPath(menuHome)} aria-current={chart ? 'page' : undefined}>
              사주보기
            </Link>
            <Link to={VILLAGE} aria-current={route.kind === 'village' ? 'page' : undefined}>
              마을
            </Link>
          </nav>

          <div className="mg-saju-body">
            <div className="mg-saju-stage" data-view={!viewed ? 'village' : bridgeShown && bridged ? 'bridge' : 'home'}>
              <Stage
                homes={homes}
                bridges={bridges}
                frame={frame}
                focus={viewed ? viewedId : null}
                onVisit={visit}
                pins={
                  !viewed &&
                  homes.map((home) => {
                    const owner = people.find(({ resident }) => resident.id === home.id)?.resident;
                    return (
                      <Link key={home.id} className="mg-saju-pin" data-pin={home.id} data-element={home.profile?.balance.dominant} to={homePath(home.id)}>
                        {owner ? owner.name : '빈 터'}
                        {home.id === MY_HOME && <small>{owner ? '내 집' : '내 집 짓기'}</small>}
                      </Link>
                    );
                  })
                }
              />
              {bridge?.kind === 'built' && bridgeShown && (
                <p className="mg-saju-say" role="status">
                  {bridge.compat.headline}
                </p>
              )}
              {viewed && (
                <div className="mg-saju-stage-foot">
                  <Bgm melody={melodyOf(viewed.profile)} />
                  {route.kind === 'mine' && <SavePicture name={viewed.resident.name} profile={viewed.profile} />}
                </div>
              )}
            </div>

            <aside className="mg-saju-side" ref={side} aria-label={title}>
              {route.kind === 'edit' || (route.kind === 'mine' && !viewed) ? (
                <Onboarding resident={state.me} suggestedName={user?.displayName ?? ''} />
              ) : route.kind === 'village' || !viewed ? (
                <VillagePanel
                  villagers={people.map(({ resident, profile }) => ({ resident, profile, bridged: state.bridges.includes(resident.id) }))}
                  hasHome={!!me}
                />
              ) : chart ? (
                <ChartPanel profile={viewed.profile} />
              ) : (
                <HomePanel
                  resident={viewed.resident}
                  profile={viewed.profile}
                  mine={route.kind === 'mine'}
                  bridge={bridge}
                  onShowBridge={setBridgeShown}
                  entries={entriesOf(state, viewed.resident.id)}
                  canWrite={!!state.me}
                  elementOf={elementOf}
                />
              )}
            </aside>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
