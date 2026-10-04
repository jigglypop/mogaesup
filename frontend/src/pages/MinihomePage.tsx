import { lazy, Suspense, useEffect, useState } from 'react';

import { Link, Navigate } from 'react-router-dom';

import { ApiRequestError } from '../api/client';
import { catalogApi, homeApi, lookApi } from '../api/endpoints';
import type { CatalogItem, HomeView, Look, VisitCounter } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { useSignInPath } from '../auth/signIn';
import { playerModelUrl } from '../minihome/character';
import { FALLBACK_MINIME, prefetchModels } from '../minihome/figures';
import { visitorId } from '../minihome/stored';
import { PageShell } from '../shell/Shell';
import { Loading } from './Loading';

// three.js and the engine load after the first paint, never in the entry chunk.
const loadMinihome = () => import('../minihome/Minihome');
const Minihome = lazy(loadMinihome);

type Loaded = {
  view: HomeView;
  minimes: CatalogItem[];
  furniture: CatalogItem[];
  /** Published 주민, for the island's residents. */
  npcs: CatalogItem[];
  viewerMinime: string;
  /** The signed-in viewer's own look from the wardrobe. */
  viewerLook: Look | null;
  /** Who it was loaded for: the signed-in viewer's username, or null for a signed-out visit. */
  as: string | null;
};

/** `/@username` and, for its owner, `/@username/edit`: loads the home, counts the visit and opens its island. */
export function MinihomePage({ username, editing }: { username: string; editing: boolean }) {
  const { status, user, lapsed } = useAuth();
  const signIn = useSignInPath();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<{ status: number; message: string } | null>(null);
  const viewerName = user?.username ?? null;
  const settled = status !== 'loading';
  // Only a different person should reload the home, not a new user object for the same one. When the session of the
  // member it was loaded for lapses, the island stays open with what they were doing (signing in again as them keeps
  // it as it is); someone else signing in, or a sign-out, loads it afresh.
  const viewerKey = !user && lapsed && loaded?.as === lapsed.username ? lapsed.username : viewerName;

  // The island's code downloads while the home's data is still on its way, not after it.
  useEffect(() => {
    void loadMinihome();
  }, []);

  useEffect(() => {
    if (!settled) return undefined;
    const controller = new AbortController();
    setLoaded(null);
    setProblem(null);
    (async () => {
      const own = viewerName === username;
      // The island does not wait for its visit to be counted: the count joins the view whenever it comes (or the view
      // keeps its own when counting fails).
      let visits: VisitCounter | null = null;
      let shown = false;
      void homeApi.visit(username, visitorId()).then(
        (counted) => {
          if (!counted || controller.signal.aborted) return;
          visits = counted;
          if (shown) setLoaded((current) => current && { ...current, view: { ...current.view, visits: counted } });
        },
        () => undefined,
      );
      // Studio furniture fills only the owner's decorating drawer.
      const studioFurniture = () => catalogApi.items('furniture').catch(() => ({ items: [] }));
      const ownFurniture = own ? studioFurniture() : null;
      // One round trip: the visitor's own home does not wait for this home to arrive.
      const [view, minimes, npcs, viewerLook, mine] = await Promise.all([
        own ? homeApi.mine() : homeApi.get(username),
        catalogApi.items('minime'),
        catalogApi.items('npc').catch(() => ({ items: [] })),
        viewerName ? lookApi.mine().then(({ look }) => look, () => null) : null,
        viewerName && !own ? homeApi.get(viewerName).catch(() => null) : null,
      ]);
      const furniture = view.isOwner ? await (ownFurniture ?? studioFurniture()) : { items: [] };
      if (controller.signal.aborted) return;
      const viewerMinime = view.isOwner ? view.profile.minime : (mine?.profile.minime ?? FALLBACK_MINIME);
      prefetchModels([playerModelUrl(viewerLook, viewerMinime, minimes.items)]);
      setLoaded({
        view: { ...view, visits: visits ?? view.visits },
        minimes: minimes.items,
        furniture: furniture.items,
        npcs: npcs.items,
        viewerMinime,
        viewerLook,
        as: viewerName,
      });
      shown = true;
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setProblem(
        error instanceof ApiRequestError
          ? { status: error.status, message: error.message }
          : { status: 0, message: '섬을 불러오지 못했어요' },
      );
    });
    return () => controller.abort();
  }, [username, settled, viewerKey]);

  if (problem) {
    return (
      <PageShell title="섬">
        <section className="mg-glass mg-panel mg-notice">
          <h1 className="mg-title">
            {problem.status === 404 ? '없는 섬이에요' : problem.status === 403 ? '주인이 닫아 둔 섬이에요' : '섬을 불러오지 못했어요'}
          </h1>
          <p className="mg-muted">{problem.message}</p>
          <div className="mg-row">
            <Link className="mg-btn is-primary" to="/explore">
              다른 섬 둘러보기
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
  if (!loaded) return <Loading />;
  // Only the owner decorates; anyone else at `/edit` just visits.
  if (editing && !loaded.view.isOwner) return <Navigate to={`/@${username}`} replace />;
  return (
    <Suspense fallback={<Loading />}>
      <Minihome
        key={username}
        view={loaded.view}
        viewer={user}
        viewerMinime={loaded.viewerMinime}
        minimes={loaded.minimes}
        studioItems={loaded.furniture}
        npcItems={loaded.npcs}
        viewerLook={loaded.viewerLook}
        onLook={(viewerLook) => setLoaded((current) => current && { ...current, viewerLook })}
        editing={editing}
        onView={(view) =>
          setLoaded(
            (current) =>
              current && { ...current, view, viewerMinime: view.isOwner ? view.profile.minime : current.viewerMinime },
          )
        }
      />
    </Suspense>
  );
}
