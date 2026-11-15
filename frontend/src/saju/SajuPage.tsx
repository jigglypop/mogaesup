import './saju.css';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import type { HomeVisibility, User } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { useSignInPath } from '../auth/signIn';
import { NeighborsTab, useNeighbors } from '../minihome/Ilchons';
import { Loading } from '../pages/Loading';
import { useStored } from '../minihome/stored';
import { Brand, PageShell, Rail, TopActions } from '../shell/Shell';
import { Icon } from '../ui/icons';
import { compatOf } from './compat';
import type { Birth } from './engine';
import { melodyOf } from './melody';
import { forgetLegacyHome, readLegacyHome, useMinihome, type Minihome } from './minihome';
import { profileOf, type Profile } from './profile';
import type { Resident } from './residents';
import { chartPath, editPath, homePath, routeOf, villagePath, waveOf, ziweiPath } from './routes';
import type { StageFlag } from './scene/Flag';
import { frameOf, NO_INSET, type Inset } from './scene/frames';
import { Stage, type StageBridge, type StageHandle, type StageHome } from './scene/Stage';
import { Bgm } from './ui/Bgm';
import { ChartPanel } from './ui/ChartPanel';
import { HomePanel, type Bridge } from './ui/HomePanel';
import { Onboarding } from './ui/Onboarding';
import { PixelIcon } from './ui/PixelIcon';
import { SavePicture } from './ui/SavePicture';
import { FlagCard, VillagePanel } from './ui/VillagePanel';
import { ZiweiPanel } from './ui/ZiweiPanel';
import { FLAG_SPOT, flagRaised, plotsOf } from './village';

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** How much one press of a zoom button brings the picture closer. */
const ZOOM_STEP = 1.3;
/** On one's own 미니홈피 there is no bridge to show. */
const NO_BRIDGE: Bridge = { compat: null, canShow: false, shown: false, onShow: () => {} };

/** A resident's chart, or null for a stored birth this version cannot read. */
function profileOrNull(resident: Resident): Profile | null {
  try {
    return profileOf(resident.birth);
  } catch {
    return null;
  }
}

/**
 * How much of the canvas, which fills the window, lies under the page's own pieces: the top bar, the rail (down the
 * left on a wide screen, along the bottom on a phone), the open panel (a column at the right, or a sheet at the
 * bottom) and the dock. The picture is fitted to what they leave. Measured from the page as it is laid out.
 */
function useCover(world: RefObject<HTMLElement | null>, panelOpen: boolean): Inset {
  const [cover, setCover] = useState<Inset>(NO_INSET);
  useLayoutEffect(() => {
    const host = world.current;
    if (!host) return undefined;
    const measure = () => {
      const all = host.getBoundingClientRect();
      if (all.width === 0 || all.height === 0) return;
      const box = (selector: string) => host.querySelector(selector)?.getBoundingClientRect() ?? null;
      const bar = box('.mg-topbar');
      const rail = box('.mg-rail');
      const dock = box('.mg-saju-dock');
      const panel = panelOpen ? box('.mg-saju-panel') : null;
      const next = { top: bar ? bar.bottom - all.top : 0, right: 0, bottom: dock ? all.bottom - dock.top : 0, left: 0 };
      if (rail && rail.height >= rail.width) next.left = rail.right - all.left;
      else if (rail) next.bottom = Math.max(next.bottom, all.bottom - rail.top);
      if (panel && panel.width < all.width * 0.7) next.right = all.right - panel.left;
      else if (panel) next.bottom = Math.max(next.bottom, all.bottom - panel.top);
      setCover((current) => (current.top === next.top && current.right === next.right && current.bottom === next.bottom && current.left === next.left ? current : next));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    for (const selector of ['.mg-saju-panel', '.mg-saju-dock', '.mg-rail']) {
      const element = host.querySelector(selector);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [world, panelOpen]);
  return cover;
}

/** Whether the story panel starts open: on a phone, upright or on its side, it would cover most of the picture. */
const panelFits = () => typeof matchMedia !== 'function' || !matchMedia('(max-width: 720px), (max-height: 500px)').matches;

/**
 * `/@username/*`: a member's 미니홈피. The village's canvas fills the window (the member's 사주 home among their
 * 이웃'), and over it float the title, the app's rail, and a panel with the story of what the address shows: the
 * home, its chart, or the village.
 */
export default function SajuPage({ username, rest }: { username: string; rest: string }) {
  const { user } = useAuth();
  const signIn = useSignInPath();
  const { state, build, demolish, open } = useMinihome(username);
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'failed') {
    return (
      <PageShell title="미니홈피">
        <section className="mg-glass mg-panel mg-notice">
          <h1 className="mg-title">
            {state.code === 404 ? '없는 미니홈피예요' : state.code === 403 ? '주인이 닫아 둔 미니홈피예요' : '미니홈피를 불러오지 못했어요'}
          </h1>
          {/* The heading already says why for a home that is missing or closed. */}
          {state.code !== 404 && state.code !== 403 && <p className="mg-muted">{state.message}</p>}
          <div className="mg-row">
            <Link className="mg-btn is-primary" to="/explore">
              둘러보기
            </Link>
            {!user && (
              <Link className="mg-btn" to={signIn}>
                로그인
              </Link>
            )}
          </div>
        </section>
      </PageShell>
    );
  }
  return <Village minihome={state.minihome} viewer={user} rest={rest} onBuild={build} onDemolish={demolish} onVisibility={open} />;
}

function Village({ minihome, viewer, rest, onBuild, onDemolish, onVisibility }: {
  minihome: Minihome;
  viewer: User | null;
  rest: string;
  onBuild: (name: string, birth: Birth) => Promise<void>;
  onDemolish: () => Promise<void>;
  onVisibility: (visibility: HomeVisibility) => Promise<void>;
}) {
  const { view, owner, village: others, mine } = minihome;
  const { username, ownerName } = view.profile;
  const { search } = useLocation();
  const navigate = useNavigate();
  const neighbors = useNeighbors(view, viewer);
  const world = useRef<HTMLDivElement>(null);
  const stage = useRef<StageHandle>(null);
  const [panelOpen, setPanelOpen] = useStored<boolean>('saju:panel', panelFits());
  // The 명반 is twelve palaces of stars: its panel can be widened for them, and stays as it was left.
  const [roomy, setRoomy] = useStored<boolean>('saju:ziwei-wide', false);
  const cover = useCover(world, panelOpen);

  // Everyone with a home here and what their chart gives. An answer to an 이웃 request or a line in the guestbook
  // leaves these as they are, and with them the homes the canvas draws.
  const host = useMemo(() => {
    const profile = owner && profileOrNull(owner);
    return owner && profile ? { resident: owner, profile } : null;
  }, [owner]);
  const around = useMemo(
    () => others.flatMap((resident) => {
      const profile = profileOrNull(resident);
      return profile ? [{ resident, profile, bridged: resident.neighbour }] : [];
    }),
    [others],
  );
  const myProfile = useMemo(() => (view.isOwner ? (host?.profile ?? null) : mine && profileOrNull(mine)), [view.isOwner, host, mine]);
  const homes = useMemo<StageHome[]>(() => {
    const plots = plotsOf(around.map(({ resident, profile }) => ({ id: resident.id, element: profile.balance.dominant })));
    return [
      { id: username, x: 0, z: 0, profile: host?.profile ?? null },
      ...plots.flatMap((plot) => {
        const neighbour = around.find(({ resident }) => resident.id === plot.id);
        return neighbour ? [{ id: plot.id, x: plot.x, z: plot.z, profile: neighbour.profile }] : [];
      }),
    ];
  }, [username, host, around]);
  // 이웃 are joined by a bridge: one from the owner's home to each of theirs.
  const bridges = useMemo<StageBridge[]>(() => {
    const from = homes[0];
    if (!host || !from) return [];
    return homes.slice(1).flatMap((to) => {
      if (!to.profile || !around.some(({ resident, bridged }) => bridged && resident.id === to.id)) return [];
      const compat = compatOf(host.profile, to.profile);
      return [{ from, to, compat, colors: [token(`--mg-${compat.from}`), token(`--mg-${compat.to}`)] as [string, string] }];
    });
  }, [homes, host, around]);

  const route = routeOf(username, rest, search, { owner: view.isOwner, built: !!host });
  const building = route.kind === 'edit' || (route.kind === 'home' && view.isOwner && !host);
  // 다리 보기: the stage shows the visitor's own home and this one, 이웃, together. It ends with the visit.
  const [bridgeShown, setBridgeShown] = useState(false);
  const joined = !view.isOwner && !!viewer && around.some(({ resident, bridged }) => bridged && resident.id === viewer.username);
  const visitorHome = joined ? (homes.find((home) => home.id === viewer?.username) ?? null) : null;
  // Another page of the 미니홈피 starts at the top of the panel.
  const side = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (side.current) side.current.scrollTop = 0;
  }, [rest]);

  // The whole village shows on its own page, and around a plot nobody has built on yet.
  const village = route.kind === 'village';
  const wide = village || !host;
  const together = bridgeShown && !wide && !!visitorHome;
  // A village whose owner has ten 이웃 has raised its flag: the island with it stands past the homes.
  const raised = flagRaised(neighbors.list.length);
  const flagElement = host?.profile.balance.dominant ?? null;
  const flag = useMemo<StageFlag | null>(() => (raised ? { ...FLAG_SPOT, element: flagElement } : null), [raised, flagElement]);
  const frame = useMemo(() => {
    const here = homes[0];
    if (wide || !here) return frameOf(flag ? [...homes, flag] : homes);
    return together && visitorHome ? frameOf([visitorHome, here]) : frameOf([here]);
  }, [homes, wide, together, visitorHome, flag]);

  const visit = useCallback((id: string) => navigate(homePath(id)), [navigate]);
  // What this browser kept from the village's first days, for a member who has not built their home here yet.
  const [legacy] = useState(() => (view.isOwner && !owner ? readLegacyHome() : null));
  const buildHome = useCallback(
    async (name: string, birth: Birth) => {
      await onBuild(name, birth);
      forgetLegacyHome();
      navigate(homePath(username));
    },
    [onBuild, navigate, username],
  );
  const takeDown = useCallback(async () => {
    await onDemolish();
    navigate(homePath(username));
  }, [onDemolish, navigate, username]);
  // The same home for as long as this village is on the page.
  const wave = useMemo(() => waveOf(around.map(({ resident }) => resident.id), viewer?.username ?? null), [around, viewer?.username]);

  if (route.kind === 'redirect') return <Navigate to={route.to} replace />;

  const name = host?.resident.name ?? ownerName;
  const title = `${name}의 미니홈피`;
  const element = host?.profile.balance.dominant ?? null;
  const tab = route.kind === 'home' && host ? route.tab : 'home';
  const widened = tab === 'ziwei' && roomy;
  const compat = !view.isOwner && myProfile && host ? compatOf(myProfile, host.profile) : null;
  const villagers = host ? [{ ...host, bridged: false }, ...around] : around;

  return (
    <div className={`mg-saju mg-saju-world${panelOpen ? ' has-panel' : ''}${widened ? ' is-roomy' : ''}`} ref={world} data-element={element ?? undefined}>
      <div className="mg-saju-stage" data-view={wide ? 'village' : together ? 'bridge' : 'home'}>
        <Stage
          ref={stage}
          homes={homes}
          bridges={bridges}
          frame={frame}
          inset={cover}
          flag={flag}
          focus={wide ? null : username}
          onVisit={visit}
          pins={
            wide &&
            homes.map((home) => {
              const resident = villagers.find((villager) => villager.resident.id === home.id)?.resident;
              return (
                <Link key={home.id} className="mg-saju-pin" data-pin={home.id} data-element={home.profile?.balance.dominant} to={homePath(home.id)} draggable={false}>
                  {resident ? resident.name : '빈 터'}
                  {home.id === viewer?.username && <small>{resident ? '내 집' : '내 집 짓기'}</small>}
                </Link>
              );
            })
          }
        />
      </div>

      <header className="mg-topbar">
        <div className="mg-topbar-left">
          <Brand />
          <div className="mg-pill mg-glass mg-saju-bar">
            <span className="mg-saju-bar-mark">
              <PixelIcon name={element ?? 'house'} size={20} />
            </span>
            <h1 className="mg-saju-bar-title">{title}</h1>
            <p className="mg-saju-visits">
              오늘 <b>{view.visits.today}</b> · 전체 <b>{view.visits.total}</b>
            </p>
          </div>
        </div>
        <TopActions>
          {viewer && !view.isOwner && (
            <Link className="mg-btn is-small" to={homePath(viewer.username)}>
              <Icon name="home" /> {mine ? '내 집' : '내 집 짓기'}
            </Link>
          )}
          {wave && (
            <Link className="mg-btn is-small" to={homePath(wave)}>
              <Icon name="wave" /> 파도타기
            </Link>
          )}
        </TopActions>
      </header>
      <Rail />

      {together && compat && (
        <p className="mg-saju-say" role="status">
          {compat.headline}
        </p>
      )}
      <div className="mg-saju-dock">
        {host && !wide && <Bgm melody={melodyOf(host.profile)} />}
        {host && !wide && view.isOwner && <SavePicture name={host.resident.name} profile={host.profile} />}
        <div className="mg-saju-zoom mg-glass" role="group" aria-label="확대와 축소">
          <button className="mg-icon-btn is-quiet" aria-label="축소" onClick={() => stage.current?.zoomBy(1 / ZOOM_STEP)}>
            <Icon name="minus" />
          </button>
          <button className="mg-icon-btn is-quiet" aria-label="확대" onClick={() => stage.current?.zoomBy(ZOOM_STEP)}>
            <Icon name="plus" />
          </button>
        </div>
      </div>

      {/* Folded, the panel stays mounted, keeping what was typed in it. */}
      <aside className="mg-saju-panel mg-glass" aria-label={title} hidden={!panelOpen}>
        <button className="mg-icon-btn is-quiet mg-saju-panel-close" aria-label="패널 접기" onClick={() => setPanelOpen(false)}>
          <Icon name="chevronRight" />
        </button>
        {tab === 'ziwei' && (
          <button className="mg-icon-btn is-quiet mg-saju-panel-roomy" aria-label={roomy ? '패널 좁히기' : '패널 넓히기'} aria-pressed={roomy} onClick={() => setRoomy(!roomy)}>
            <Icon name={roomy ? 'narrow' : 'widen'} />
          </button>
        )}
        <nav className="mg-saju-menu" aria-label="미니홈피 메뉴">
          <Link to={homePath(username)} aria-current={route.kind !== 'village' && tab === 'home' ? 'page' : undefined}>
            홈
          </Link>
          {host && (
            <Link to={chartPath(username)} aria-current={tab === 'chart' ? 'page' : undefined}>
              사주보기
            </Link>
          )}
          {host && (
            <Link to={ziweiPath(username)} aria-current={tab === 'ziwei' ? 'page' : undefined}>
              자미두수
            </Link>
          )}
          <Link to={villagePath(username)} aria-current={village ? 'page' : undefined}>
            마을
          </Link>
        </nav>
        <div className="mg-saju-side" ref={side}>
          {building ? (
            <>
              <Onboarding
                key={host ? 'again' : 'first'}
                built={!!host}
                known={owner ?? legacy}
                suggestedName={ownerName}
                cancelTo={homePath(username)}
                onBuild={buildHome}
                onDemolish={takeDown}
              />
              {/* An owner who has not built yet still has a guestbook to read, requests to answer and a door to close. */}
              {route.kind === 'home' && <HomePanel view={view} viewer={viewer} profile={null} neighbors={neighbors} bridge={NO_BRIDGE} onVisibility={onVisibility} />}
            </>
          ) : village ? (
            <>
              <VillagePanel owner={{ username, name }} villagers={villagers} viewer={viewer?.username ?? null} />
              <FlagCard neighbours={neighbors.list.length} />
              <section aria-label="이웃">
                <NeighborsTab view={view} viewer={viewer} neighbors={neighbors} />
              </section>
            </>
          ) : tab === 'chart' && host ? (
            <ChartPanel profile={host.profile} />
          ) : tab === 'ziwei' && host ? (
            <ZiweiPanel birth={host.resident.birth} editTo={view.isOwner ? editPath(username) : null} />
          ) : (
            <HomePanel
              view={view}
              viewer={viewer}
              profile={host?.profile ?? null}
              neighbors={neighbors}
              bridge={{ compat, canShow: !!visitorHome, shown: together, onShow: setBridgeShown }}
              onVisibility={onVisibility}
            />
          )}
        </div>
      </aside>
      {!panelOpen && (
        <button className="mg-btn mg-saju-panel-open" onClick={() => setPanelOpen(true)}>
          <Icon name="panel" /> <span>{name}의 이야기</span>
        </button>
      )}
    </div>
  );
}
