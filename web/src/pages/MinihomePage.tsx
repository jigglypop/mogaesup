import { lazy, Suspense, useEffect, useState } from 'react';

import { Link, Navigate } from 'react-router-dom';

import { ApiRequestError } from '../api/client';
import { catalogApi, homeApi } from '../api/endpoints';
import type { CatalogItem, HomeView } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { modelUrl, prefetchModels, RESIDENT_MODELS } from '../minihome/figures';
import { visitorId } from '../minihome/stored';
import { PageShell } from '../shell/Shell';
import { Loading } from './Loading';

// three.js and the engine load after the first paint, never in the entry chunk.
const loadMinihome = () => import('../minihome/Minihome');
const Minihome = lazy(loadMinihome);

type Loaded = { view: HomeView; minimes: CatalogItem[]; furniture: CatalogItem[]; viewerMinime: string };

/** `/@username` and, for its owner, `/@username/edit`: loads the home, counts the visit and opens its island. */
export function MinihomePage({ username, editing }: { username: string; editing: boolean }) {
  const { status, user } = useAuth();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<{ status: number; message: string } | null>(null);
  // Only a different person should reload the home, not a new user object for the same one.
  const viewerName = user?.username ?? null;

  // The island's code and its residents download while the home's data is still on its way, not after it.
  useEffect(() => {
    void loadMinihome();
    prefetchModels(RESIDENT_MODELS.map(modelUrl));
  }, []);

  useEffect(() => {
    if (status === 'loading') return undefined;
    const controller = new AbortController();
    setLoaded(null);
    setProblem(null);
    (async () => {
      const own = viewerName === username;
      const [view, minimes, furniture] = await Promise.all([
        own ? homeApi.mine() : homeApi.get(username),
        catalogApi.items('minime'),
        catalogApi.items('furniture').catch(() => ({ items: [] })),
      ]);
      const [mine, visits] = await Promise.all([
        viewerName && !view.isOwner ? homeApi.get(viewerName).catch(() => null) : null,
        homeApi.visit(username, visitorId()).catch(() => view.visits),
      ]);
      if (controller.signal.aborted) return;
      const viewerMinime = view.isOwner ? view.profile.minime : (mine?.profile.minime ?? 'man');
      prefetchModels([minimes.items.find((item) => item.id === viewerMinime)?.modelUrl ?? modelUrl('man')]);
      setLoaded({ view: { ...view, visits }, minimes: minimes.items, furniture: furniture.items, viewerMinime });
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setProblem(
        error instanceof ApiRequestError
          ? { status: error.status, message: error.message }
          : { status: 0, message: '섬을 불러오지 못했어요' },
      );
    });
    return () => controller.abort();
  }, [username, status, viewerName]);

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
              <Link className="mg-btn" to="/">
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
