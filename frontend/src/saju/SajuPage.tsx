import './saju.css';

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import { sajuApi, socialApi } from '../api/endpoints';
import type { HomeVisibility, ProfileChanges, Terrain, User } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { useSignInPath } from '../auth/signIn';
import { NeighborActions, NeighborsTab, useNeighbors } from '../minihome/Ilchons';
import { Loading } from '../pages/Loading';
import { useStored } from '../minihome/stored';
import { Brand, PageShell, TopActions } from '../shell/Shell';
import { Icon } from '../ui/icons';
import { compatOf } from './compat';
import { keyOf, pillarsOf, readingOf as chartOf, type Birth } from './engine';
import { flagDesignOf, itemId, MOST_ITEMS, useDecor } from './decor';
import { forgetLegacyHome, readLegacyHome, useMinihome, type Minihome } from './minihome';
import { profileOf, type Profile } from './profile';
import type { Resident } from './residents';
import { chartPath, editPath, homePath, routeOf, villagePath, waveOf, ziweiPath } from './routes';
import type { StageFlag } from './scene/Flag';
import { DecorLayer } from './scene/Decor';
import { frameOf, NO_INSET, type Inset, type Spot } from './scene/frames';
import type { GuestNote } from './scene/GuestPlaques';
import { Stage, type StageBridge, type StageHandle, type StageHome } from './scene/Stage';
import { Walkers, type WalkerControl } from './scene/Walkers';
import { useVillageRoom, type Action } from './live';
import { TalkBar } from './ui/TalkBar';
import { ChartPanel } from './ui/ChartPanel';
import { HomePanel, type Bridge } from './ui/HomePanel';
import { Onboarding } from './ui/Onboarding';
import { DecorCard, GiveFlagCard, type DecorSection, type Placing } from './ui/DecorCard';
import { ElementShelf } from './ui/ElementShelf';
import { CompatGiftCard } from './ui/CompatGiftCard';
import { PictureCard, PictureView, usePicture } from './ui/Picture';
import { PhotoBoardCard } from './ui/PhotoBoardCard';
import { TerrainPicker } from './ui/TerrainPicker';
import { PixelIcon } from './ui/PixelIcon';
import { ReadingCard, useReading } from './ui/Reading';
import { SavePicture } from './ui/SavePicture';
import { SaveReport } from './ui/SaveReport';
import { FlagCard, VillagePanel } from './ui/VillagePanel';
import { ZiweiPanel } from './ui/ZiweiPanel';
import { FLAG_SPOT, flagRaised, plotsOf } from './village';

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** How much one press of a zoom button brings the picture closer. */
const ZOOM_STEP = 1.3;
/** No lines hung on the 기념 방명록 yet (another 섬's are not this one's). */
const NO_NOTES: readonly GuestNote[] = [];
/** On one's own 섬 there is no bridge to show. */
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
 * How much of the canvas, which fills the window, lies under the page's own pieces: the top bar, the open panel (a
 * column at the right, or a sheet at the bottom) and the dock. The picture is fitted to what they leave. Measured from
 * the page as it is laid out: `host` is the page's element while it is in the document, so the measuring starts with
 * it (a render that only redirects has none) and again with the one that takes its place.
 */
function useCover(host: HTMLElement | null, panelOpen: boolean): Inset {
  const [cover, setCover] = useState<Inset>(NO_INSET);
  useLayoutEffect(() => {
    if (!host) return undefined;
    const measure = () => {
      const all = host.getBoundingClientRect();
      if (all.width === 0 || all.height === 0) return;
      const box = (selector: string) => host.querySelector(selector)?.getBoundingClientRect() ?? null;
      const bar = box('.mg-topbar');
      const dock = box('.mg-saju-dock');
      const panel = panelOpen ? box('.mg-saju-panel') : null;
      const next = { top: bar ? bar.bottom - all.top : 0, right: 0, bottom: dock ? all.bottom - dock.top : 0, left: 0 };
      // A column stands beside the picture; a sheet, which runs the width of the window, lies under the picture.
      if (panel && panel.width < all.width * 0.7) next.right = all.right - panel.left;
      else if (panel) next.bottom = Math.max(next.bottom, all.bottom - panel.top);
      setCover((current) => (current.top === next.top && current.right === next.right && current.bottom === next.bottom && current.left === next.left ? current : next));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    for (const selector of ['.mg-saju-panel', '.mg-saju-dock']) {
      const element = host.querySelector(selector);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [host, panelOpen]);
  return cover;
}

/**
 * Whether the canvas has drawn `username`'s village (it marks itself with whose, see Stage): `host` is the page's
 * element, as for {@link useCover}. Once drawn it stays drawn, for as long as the page shows that 섬.
 */
function useDrawn(host: HTMLElement | null, username: string): boolean {
  const [drawn, setDrawn] = useState<string | null>(null);
  const seen = drawn === username;
  useEffect(() => {
    if (!host || seen) return undefined;
    const check = () => {
      const canvas = host.querySelector<HTMLElement>('.mg-saju-canvas[data-drawn]');
      if (canvas?.dataset['drawn'] === username) setDrawn(username);
    };
    check();
    if (typeof MutationObserver !== 'function') return undefined;
    const observer = new MutationObserver(check);
    observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-drawn'] });
    return () => observer.disconnect();
  }, [host, seen, username]);
  return seen;
}

/**
 * Whether the story panel starts open: on a phone, upright or on its side, it would cover most of the picture. (The
 * same sizes at which saju.css lays the phone's sheet and the short window's column.)
 */
const panelFits = () => typeof matchMedia !== 'function' || !matchMedia('(max-width: 720px), (max-height: 500px)').matches;

/**
 * `/@username/*`: a member's 섬. The village's canvas fills the window (the member's 사주 home among their
 * 이웃'), and over it float the title and a panel with the story of what the address shows: the home, its chart, or
 * the village.
 */
export default function SajuPage({ username, rest }: { username: string; rest: string }) {
  const { user } = useAuth();
  const signIn = useSignInPath();
  const { search } = useLocation();
  const { state, build, demolish, open, saveProfile } = useMinihome(username);
  // The 섬 on the page, and the address it was shown for. Going to another 섬 keeps it until the next one has been read:
  // the canvas, its renderer and every shader it has made stay, and the islands both villages share stay built (see
  // Stage, which makes the next village ready out of sight). Its panel waits meanwhile.
  const shown = useRef<{ minihome: Minihome; rest: string; search: string } | null>(null);
  if (state.status === 'ready') shown.current = { minihome: state.minihome, rest, search };
  if (state.status === 'failed') shown.current = null;
  if (state.status === 'loading' && !shown.current) return <Loading />;
  if (state.status === 'failed') {
    // Somewhere else to go: the viewer's own home, unless it is the one that could not be read, or the way in.
    const away = user ? (user.username === username ? null : { to: homePath(user.username), label: '내 집' }) : { to: signIn, label: '로그인' };
    return (
      <PageShell title="섬">
        <section className="mg-glass mg-panel mg-notice">
          <h1 className="mg-title">
            {state.code === 404 ? '없는 섬이에요' : state.code === 403 ? '주인이 닫아 둔 섬이에요' : '섬을 불러오지 못했어요'}
          </h1>
          {/* The heading already says why for a home that is missing or closed, and when no answer came at all. */}
          {state.code !== 404 && state.code !== 403 && state.code !== 0 && <p className="mg-muted">{state.message}</p>}
          {away && (
            <div className="mg-row">
              <Link className="mg-btn is-primary" to={away.to}>
                {away.label}
              </Link>
            </div>
          )}
        </section>
      </PageShell>
    );
  }
  const page = shown.current!;
  return (
    <Village
      minihome={page.minihome}
      viewer={user}
      rest={page.rest}
      search={page.search}
      waiting={state.status === 'loading'}
      onBuild={build}
      onDemolish={demolish}
      onVisibility={open}
      onProfile={saveProfile}
    />
  );
}

function Village({ minihome, viewer, rest, search, waiting, onBuild, onDemolish, onVisibility, onProfile }: {
  minihome: Minihome;
  viewer: User | null;
  rest: string;
  search: string;
  /** The next 섬 is being read: this one's panel waits, and its village stays on the canvas until it comes. */
  waiting: boolean;
  onBuild: (name: string, birth: Birth) => Promise<void>;
  onDemolish: () => Promise<void>;
  onVisibility: (visibility: HomeVisibility, consent?: boolean) => Promise<void>;
  onProfile: (changes: ProfileChanges) => Promise<void>;
}) {
  const { view, owner, village: others, mine } = minihome;
  const { username, ownerName } = view.profile;
  const navigate = useNavigate();
  const neighbors = useNeighbors(view, viewer);
  // The page's element, kept in state: what measures the page follows the element that is in the document.
  const [world, setWorld] = useState<HTMLDivElement | null>(null);
  const stage = useRef<StageHandle>(null);
  // Whether the panel starts open is the window's to say, and what the viewer chose since is kept for that kind of
  // window: folding a phone's sheet does not fold a wide window's column.
  const [fits] = useState(panelFits);
  const [panelOpen, setPanelOpen] = useStored<boolean>(fits ? 'saju:panel' : 'saju:sheet', fits);
  // The 명반 is twelve palaces of stars: its panel can be widened for them, and stays as it was left.
  const [roomy, setRoomy] = useStored<boolean>('saju:ziwei-wide', false);
  const cover = useCover(world, panelOpen);
  // Folding and opening take the keyboard along: the button pressed goes away with the press, and focus goes to the
  // one that undoes it.
  const panelId = useId();
  const decorId = useId();
  const folder = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const pressed = useRef(false);
  const showPanel = (open: boolean) => {
    pressed.current = true;
    setPanelOpen(open);
  };
  useEffect(() => {
    if (!pressed.current) return;
    pressed.current = false;
    (panelOpen ? folder : opener).current?.focus();
  }, [panelOpen]);

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
  const [bridge, setBridge] = useState({ of: username, shown: false });
  const bridgeShown = bridge.of === username && bridge.shown;
  const setBridgeShown = useCallback((shown: boolean) => setBridge({ of: username, shown }), [username]);
  const joined = !view.isOwner && !!viewer && around.some(({ resident, bridged }) => bridged && resident.id === viewer.username);
  const visitorHome = joined ? (homes.find((home) => home.id === viewer?.username) ?? null) : null;
  // Another page of the 섬 starts at the top of the panel: the tabs of the home differ in the query alone.
  const side = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (side.current) side.current.scrollTop = 0;
  }, [username, rest, search]);

  // The whole village shows on its own page, and around a plot nobody has built on yet.
  const village = route.kind === 'village';
  const wide = village || !host;
  const together = bridgeShown && !wide && !!visitorHome;
  // How many 이웃 the owner has, once their list has been read: until then nobody can say, and nothing here does.
  const neighbours = neighbors.loaded ? neighbors.list.length : null;
  // A village whose owner has ten 이웃 has raised its flag: the island with it stands past the homes.
  const raised = neighbours !== null && flagRaised(neighbours);
  const flagElement = host?.profile.balance.dominant ?? null;
  const flag = useMemo<StageFlag | null>(() => (raised ? { ...FLAG_SPOT, element: flagElement } : null), [raised, flagElement]);
  const frame = useMemo(() => {
    const here = homes[0];
    if (wide || !here) return frameOf(flag ? [...homes, flag] : homes);
    return together && visitorHome ? frameOf([visitorHome, here]) : frameOf([here]);
  }, [homes, wide, together, visitorHome, flag]);

  const visit = useCallback((id: string) => navigate(homePath(id)), [navigate]);
  // What the owner has placed on the 섬 (see decor): their flag flies from the owner's chart, whoever looks. A visitor
  // with a home of their own can give the 섬 theirs. While the owner picks a place for something, a press on the
  // island places it and visits nothing.
  const decor = useDecor(username, view.isOwner ? view.profile.ownerId : null);
  const ownFlag = useMemo(() => (host ? flagDesignOf(host.resident.birth) : null), [host]);
  const board = decor.decor?.photoBoard;
  const photoBoard = useMemo(() => board ? { ...board, url: `/api/homes/${encodeURIComponent(username)}/saju/photo-board/${board.version}` } : null, [board, username]);
  const [openPhoto, setOpenPhoto] = useState<string | null>(null);
  const showBoard = () => setOpenPhoto(photoBoard?.url ?? null);
  const islandDecor = useMemo(() => decor.decor && ({
    items: decor.decor.items, flags: decor.decor.flags, gifts: decor.decor.gifts,
    terrain: decor.decor.terrain ?? 'default',
    tiles: decor.decor.tiles ?? [],
    own: ownFlag, character: decor.decor.character?.modelUrl ?? null, photoBoard,
  }), [decor.decor, ownFlag, photoBoard]);
  const giftFlag = useMemo(() => (!view.isOwner && viewer && mine ? flagDesignOf(mine.birth) : null), [view.isOwner, viewer, mine]);
  const [placingFor, setPlacingFor] = useState<{ of: string; placing: Placing | null }>({ of: username, placing: null });
  const [decorTab, setDecorTab] = useState<{ of: string; section: DecorSection }>({ of: username, section: 'items' });
  const decorSection = decorTab.of === username ? decorTab.section : 'items';
  const canDecorate = view.isOwner && !!host && route.kind === 'home' && route.tab === 'home' && !waiting;
  const placing = canDecorate && placingFor.of === username ? placingFor.placing : null;
  const [brushFor, setBrushFor] = useState<{ of: string; brush: Terrain | null }>({ of: username, brush: null });
  const brush = canDecorate && !placing && brushFor.of === username ? brushFor.brush : null;
  const [leavingGift, setLeavingGift] = useState(false);
  const [selectedFor, setSelectedFor] = useState<{ of: string; id: string } | null>(null);
  const selectedId = canDecorate && selectedFor?.of === username ? selectedFor.id : null;
  const setPlacing = useCallback((next: Placing | null) => {
    setPlacingFor({ of: username, placing: next });
    if (next && !next.itemId) setSelectedFor(null);
  }, [username]);
  const selectItem = useCallback((id: string | null) => {
    setSelectedFor(id ? { of: username, id } : null);
    setPlacing(null);
  }, [username, setPlacing]);
  const selectOnIsland = useCallback((id: string) => {
    selectItem(id);
    setDecorTab({ of: username, section: 'items' });
    setPanelOpen(true);
    requestAnimationFrame(() => side.current?.querySelector<HTMLElement>('.mg-decor-inspector')?.scrollIntoView?.({ block: 'nearest' }));
  }, [selectItem, setPanelOpen, username]);
  const showDecor = () => {
    setPanelOpen(true);
    requestAnimationFrame(() => {
      const editor = document.getElementById(decorId);
      editor?.scrollIntoView?.({ block: 'start' });
      editor?.querySelector<HTMLButtonElement>('[role=tab][aria-selected=true]')?.focus({ preventScroll: true });
    });
  };
  const placeAt = useCallback(
    (spot: Spot) => {
      if (!placing || !decor.decor) return;
      const round = (value: number) => Math.round(value * 100) / 100;
      const items = decor.decor.items;
      const at = { x: round(spot.x), z: round(spot.z) };
      const id = placing.itemId ?? itemId();
      if (placing.itemId) {
        if (!items.some((item) => item.id === id)) return setPlacing(null);
        decor.place(items.map((item) => item.id === id ? { ...item, ...at } : item));
      } else {
        if (items.length >= MOST_ITEMS) return setPlacing(null);
        decor.place([...items, { id, kind: placing.kind, ref: placing.ref, ...at, turn: 0 }]);
      }
      selectOnIsland(id);
    },
    [placing, decor, selectOnIsland, setPlacing],
  );
  const paintAt = useCallback((spot: Spot) => {
    if (!brush) return;
    decor.paintCell(spot.x, spot.z, brush);
  }, [brush, decor]);
  const compat = !view.isOwner && myProfile && host ? compatOf(myProfile, host.profile) : null;
  const leaveAt = useCallback((spot: Spot) => {
    if (!leavingGift || !viewer || !mine || !host || !compat) return;
    const design = { tone: compat.tone, from: compat.from, to: compat.to };
    const pillars = (birth: Birth) => pillarsOf(chartOf(birth)).map(({ pillar }) => pillar.cn);
    void sajuApi.giveGift(host.resident.id, {
      expectedGiverId: viewer.id, giverBirth: mine.birth, recipientBirth: host.resident.birth, design,
      giverPillars: pillars(mine.birth), recipientPillars: pillars(host.resident.birth), x: spot.x, z: spot.z,
    }).then(() => {
      setLeavingGift(false);
      decor.reload();
    }, () => setLeavingGift(false));
  }, [leavingGift, viewer, mine, host, compat, decor]);
  // What this browser kept from the village's first days, for a member who has not built their home here yet.
  const legacy = useMemo(() => (view.isOwner && !owner ? readLegacyHome() : null), [username, view.isOwner, owner]);
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

  const name = host?.resident.name ?? ownerName;
  const title = `${name}의 섬`;
  // The browser's tab, its history and a bookmark say whose 섬 it is.
  useEffect(() => {
    const before = document.title;
    document.title = before ? `${title} · ${before}` : title;
    return () => {
      document.title = before;
    };
  }, [title]);

  // What the server makes for the built home from its birth: the reading of its chart, read once its tabs are opened,
  // and the picture of its island. The owner's are asked for here, and looked at again while they are being made and
  // shown: the reading on its tabs, the picture on the home's (and for the PDF on the reading's).
  const tab = route.kind === 'home' && host ? route.tab : 'home';

  // The home's room: everyone signed in here walks its island as their own guardian dog, and what they say shows over
  // them. The viewer's dog walks where they press the island's ground.
  const walking = !!viewer && !wide && !placing && !brush && !leavingGift;
  const myDog = myProfile?.guardian.dog ?? '02';
  const start = useMemo<[number, number, number]>(() => {
    const seed = [...(viewer?.id ?? '')].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return [0.5 + ((seed % 7) - 3) * 0.45, 0, 3.6 + ((seed % 5) - 2) * 0.3];
  }, [viewer?.id]);
  const room = useVillageRoom(username, walking ? (viewer?.id ?? null) : null, myDog, start);
  // Where the viewer's dog is going (a press on the ground; twice, it runs) and what it was last asked to do.
  const control = useRef<WalkerControl>({ goal: null, run: false, asked: null });
  const walkTo = useCallback((spot: Spot, twice: boolean) => {
    control.current.goal = [spot.x, 0, spot.z];
    control.current.run = twice;
  }, []);
  const ask = useCallback((action: Action) => {
    control.current.asked = { action, at: performance.now() };
  }, []);
  // Space jumps, wherever the page leaves the key to it.
  useEffect(() => {
    if (!walking) return undefined;
    const key = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return;
      const target = event.target as Element | null;
      if (target?.closest('input, textarea, select, button, a, [contenteditable], main')) return;
      event.preventDefault();
      ask('jump');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [walking, ask]);
  const talkLayer = useRef<HTMLDivElement>(null);

  // The guestbook's lines, hung as plaques on the island's 기념 방명록: read with the 섬, and again when one is left or
  // taken away. Pressing the frame opens the guestbook, to leave one.
  const [notesRead, setNotesRead] = useState(0);
  const rereadNotes = useCallback(() => setNotesRead((count) => count + 1), []);
  const [notes, setNotes] = useState<{ of: string; list: GuestNote[] }>({ of: '', list: [] });
  useEffect(() => {
    const controller = new AbortController();
    socialApi.guestbook(username, undefined, controller.signal).then(
      (page) => setNotes({ of: username, list: page.entries.map((entry) => ({ id: entry.id, key: entry.author.username })) }),
      () => undefined,
    );
    return () => controller.abort();
  }, [username, notesRead]);
  const onHome = route.kind === 'home' && tab === 'home';
  const openGuestbook = useCallback(() => {
    if (!onHome) navigate(homePath(username));
    setPanelOpen(true);
    window.setTimeout(() => {
      const section = document.querySelector<HTMLElement>('.mg-saju-guestbook');
      section?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      section?.querySelector<HTMLElement>('textarea, a')?.focus({ preventScroll: true });
    }, 80);
  }, [onHome, navigate, username, setPanelOpen]);
  const ownerId = view.isOwner ? view.profile.ownerId : null;
  const birth = host?.resident.birth ?? null;
  const reading = useReading({ username, ownerId, birth, shown: route.kind === 'home' && tab !== 'home' });
  const drawn = useDrawn(world, username);
  const picture = usePicture({
    username,
    ownerId,
    birth,
    profile: host?.profile ?? null,
    decor: islandDecor,
    // The island is complete once it is built and on the canvas, and not while its birth is being entered again.
    complete: drawn && !!islandDecor && route.kind !== 'edit',
    poll: route.kind === 'home',
  });

  if (route.kind === 'redirect') return <Navigate to={route.to} replace />;

  const element = host?.profile.balance.dominant ?? null;
  // The panel widens for the 명반, and a birth without an hour has none.
  const charted = tab === 'ziwei' && !!host?.resident.birth.time;
  const widened = charted && roomy;
  const villagers = host ? [{ ...host, bridged: false }, ...around] : around;
  // Each tab of the chart opens with its part of the reading; a written one can be saved as a PDF, with the picture.
  const pictureUrl = picture.made?.status === 'ready' ? picture.made.url : null;
  const readingOf = (part: 'saju' | 'ziwei') =>
    host && (
      <ReadingCard
        part={part}
        state={reading}
        owner={view.isOwner}
        onAsk={reading.ask}
        onReload={reading.reload}
        report={(written) => <SaveReport name={host.resident.name} birth={host.resident.birth} reading={written} pictureUrl={pictureUrl} decor={islandDecor} />}
      />
    );

  return (
    <div className={`mg-saju mg-saju-world${panelOpen ? ' has-panel' : ''}${widened ? ' is-roomy' : ''}`} ref={setWorld} data-element={element ?? undefined}>
      {/* The top bar comes first, to the keyboard and to a screen reader too: the labels on the picture come after it. */}
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
            <Link className="mg-btn is-small mg-saju-action is-mine" to={homePath(viewer.username)}>
              <Icon name="home" /> <span>{mine ? '내 집' : '내 집 짓기'}</span>
            </Link>
          )}
          {wave && (
            <Link className="mg-btn is-small mg-saju-action" to={homePath(wave)}>
              <Icon name="wave" /> <span>파도타기</span>
            </Link>
          )}
        </TopActions>
      </header>

      {/* What the page's pieces cover, for what the canvas centres in the part they leave open (see saju.css). */}
      <div
        className="mg-saju-stage"
        data-view={wide ? 'village' : together ? 'bridge' : 'home'}
        style={{ '--mg-cover-top': `${cover.top}px`, '--mg-cover-right': `${cover.right}px`, '--mg-cover-bottom': `${cover.bottom}px`, '--mg-cover-left': `${cover.left}px` } as CSSProperties}
      >
        <Stage
          ref={stage}
          homes={homes}
          bridges={bridges}
          frame={frame}
          inset={cover}
          flag={flag}
          focus={wide ? null : username}
          onVisit={placing || brush || leavingGift ? undefined : visit}
          onPlace={placing ? placeAt : brush ? paintAt : leavingGift ? leaveAt : undefined}
          terrain={islandDecor?.terrain ?? 'default'}
          onSelectItem={canDecorate ? selectOnIsland : undefined}
          onOpenPhoto={photoBoard ? showBoard : undefined}
          notes={notes.of === username ? notes.list : NO_NOTES}
          onBoard={placing ? undefined : openGuestbook}
          onWalk={walking ? walkTo : undefined}
          guardianAway={walking && view.isOwner}
          overlay={<div className="mg-saju-walkers" ref={talkLayer} />}
          decor={
            <>
              {islandDecor && <DecorLayer {...islandDecor} selectedId={selectedId} />}
              {walking && (
                <Walkers
                  room={room}
                  own={myDog}
                  name={viewer?.displayName ?? ''}
                  start={start}
                  control={control}
                  layer={talkLayer}
                  {...(view.isOwner && view.profile.balloon ? { balloon: view.profile.balloon } : {})}
                />
              )}
            </>
          }
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

      {together && compat && (
        <p className="mg-saju-say" role="status">
          {compat.headline}
        </p>
      )}
      <div className="mg-saju-dock" data-own-decor={canDecorate || undefined}>
        {walking && room.connected && <TalkBar log={room.log} others={room.present.length} onSay={room.say} onMove={ask} />}
        {walking && room.elsewhere && (
          <p className="mg-saju-elsewhere mg-glass" role="status">
            다른 창에서 이 섬에 들어와 있어요
            <button className="mg-btn is-small" onClick={room.rejoin}>
              여기서 들어가기
            </button>
          </p>
        )}
        {canDecorate && (
          <button className="mg-btn mg-saju-edit" type="button" aria-controls={decorId} disabled={!islandDecor} onClick={showDecor}>
            <Icon name="brush" /> <span>꾸미기</span>
          </button>
        )}
        {host && !wide && view.isOwner && <SavePicture name={host.resident.name} profile={host.profile} decor={islandDecor} />}
        <div className="mg-saju-zoom mg-glass" role="group" aria-label="확대와 축소">
          <button className="mg-icon-btn is-quiet" aria-label="축소" onClick={() => stage.current?.zoomBy(1 / ZOOM_STEP)}>
            <Icon name="minus" />
          </button>
          <button className="mg-icon-btn is-quiet" aria-label="확대" onClick={() => stage.current?.zoomBy(ZOOM_STEP)}>
            <Icon name="plus" />
          </button>
        </div>
        {/* The folded panel opens from the end of this row under a sheet, and from a column's head beside one. */}
        {!panelOpen && (
          <button ref={opener} className="mg-btn mg-saju-panel-open" aria-expanded="false" aria-controls={panelId} onClick={() => showPanel(true)}>
            <Icon name="panel" /> <span>{name}의 이야기</span>
          </button>
        )}
      </div>

      {/* The island being drawn off the page, to be drawn again as the home's picture. */}
      {picture.shot}
      {photoBoard && openPhoto === photoBoard.url && <PictureView url={photoBoard.url} alt="전광판 사진" size={photoBoard} onClose={() => setOpenPhoto(null)} />}

      {/* What the 섬 says, beside the picture of it. Folded, the panel stays mounted, keeping what was typed in it. */}
      {/* While the next 섬 is read its panel waits: this one's cannot be used for it. */}
      <main id={panelId} className="mg-saju-panel mg-glass" aria-label={title} aria-busy={waiting || undefined} inert={waiting} hidden={!panelOpen}>
        <button ref={folder} className="mg-icon-btn is-quiet mg-saju-panel-close" aria-label="패널 접기" aria-expanded="true" aria-controls={panelId} onClick={() => showPanel(false)}>
          <Icon name="chevronRight" />
        </button>
        {/* One name, and pressed while the panel is wide. */}
        {charted && (
          <button className="mg-icon-btn is-quiet mg-saju-panel-roomy" aria-label="패널 넓히기" aria-pressed={roomy} onClick={() => setRoomy(!roomy)}>
            <Icon name={roomy ? 'narrow' : 'widen'} />
          </button>
        )}
        <nav className="mg-saju-menu" aria-label="섬 메뉴">
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
        {/* The column takes the keyboard's focus, so the arrow and page keys scroll it where nothing in it does. */}
        <div className="mg-saju-side" ref={side} tabIndex={0}>
          {/* Each 섬's own: what was typed or opened in one is not carried to the next. */}
          <Fragment key={username}>
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
              {route.kind === 'home' && <HomePanel view={view} viewer={viewer} profile={null} neighbors={neighbors} bridge={NO_BRIDGE} onVisibility={onVisibility} onProfile={onProfile} />}
            </>
          ) : village ? (
            <>
              <VillagePanel owner={{ username, name }} villagers={villagers} viewer={viewer?.username ?? null} />
              {neighbours !== null && <FlagCard neighbours={neighbours} />}
              <section aria-label="이웃">
                {neighbors.loaded ? (
                  <NeighborsTab view={view} viewer={viewer} neighbors={neighbors} />
                ) : (
                  // A list not read yet, or one that could not be: what can be done and what went wrong, and no count.
                  <div className="mg-neighbors">
                    <NeighborActions view={view} viewer={viewer} neighbors={neighbors} />
                  </div>
                )}
              </section>
            </>
          ) : tab === 'chart' && host ? (
            <ChartPanel profile={host.profile} head={readingOf('saju')} />
          ) : tab === 'ziwei' && host ? (
            <ZiweiPanel birth={host.resident.birth} editTo={view.isOwner ? editPath(username) : null} head={readingOf('ziwei')} />
          ) : (
            <HomePanel
              view={view}
              viewer={viewer}
              profile={host?.profile ?? null}
              picture={
                host && (
                  <PictureCard name={host.resident.name} state={picture} drawing={picture.drawing} owner={view.isOwner} onDraw={picture.draw} onReload={picture.reload} />
                )
              }
              decor={
                host &&
                (view.isOwner ? (
                  <DecorCard
                    id={decorId}
                    section={decorSection}
                    onSection={(section) => {
                      setDecorTab({ of: username, section });
                      if (section !== 'items') selectItem(null);
                    }}
                    state={decor}
                    own={ownFlag}
                    placing={placing}
                    onPlacing={setPlacing}
                    selectedId={selectedId}
                    onSelect={(id) => {
                      selectItem(id);
                      const item = decor.decor?.items.find((one) => one.id === id);
                      if (item) stage.current?.focusItem({ x: item.x, z: item.z });
                    }}
                    terrainPick={(
                      <TerrainPicker
                        value={decor.decor?.terrain ?? 'default'}
                        brush={brush}
                        onBrush={(tile) => setBrushFor({ of: username, brush: tile })}
                        onFill={decor.setTerrain}
                      />
                    )}
                    photoBoard={<PhotoBoardCard photo={photoBoard} onChange={decor.changePhoto} onOpen={showBoard} />}
                  >
                    <ElementShelf balance={host.profile.balance} dayMaster={host.profile.dayMaster} placing={placing} onPlacing={setPlacing} full={(decor.decor?.items.length ?? 0) >= MOST_ITEMS} />
                  </DecorCard>
                ) : (
                  <>
                    {photoBoard && <div className="mg-saju-card"><PhotoBoardCard photo={photoBoard} onOpen={showBoard} /></div>}
                    {viewer && mine && compat && (
                      <CompatGiftCard key={`${viewer.id}|${username}|${keyOf(mine.birth)}|${keyOf(host.resident.birth)}`} giverId={viewer.id} giver={mine} recipient={host.resident} compat={compat} leaving={leavingGift} onLeave={() => setLeavingGift((on) => !on)} />
                    )}
                    {giftFlag && <GiveFlagCard key={username} own={giftFlag} onGive={decor.give} />}
                  </>
                ))
              }
              neighbors={neighbors}
              bridge={{ compat, canShow: !!visitorHome, shown: together, onShow: setBridgeShown }}
              onVisibility={onVisibility}
              onProfile={onProfile}
              onGuestbook={rereadNotes}
            />
          )}
          </Fragment>
        </div>
      </main>
    </div>
  );
}
