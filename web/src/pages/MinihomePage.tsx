import { lazy, Suspense, useEffect, useState } from 'react';

import { Link, useNavigate } from 'react-router-dom';

import { ApiRequestError } from '../api/client';
import { catalogApi, homeApi } from '../api/endpoints';
import type { CatalogItem, HomeView } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { modelUrl, prefetchModels, RESIDENT_MODELS } from '../minihome/figures';
import { visitorId } from '../minihome/stored';
import { Loading } from './Loading';

// three.js and the engine load after the first paint, never in the entry chunk.
const loadMinihome = () => import('../minihome/Minihome');
const Minihome = lazy(loadMinihome);

type Loaded = { view: HomeView; minimes: CatalogItem[]; viewerMinime: string };

/** `/@username`: loads the home, counts the visit, and opens its island for the owner or a visitor. */
export function MinihomePage({ username }: { username: string }) {
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();
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
      const [view, catalog] = await Promise.all([
        own ? homeApi.mine() : homeApi.get(username),
        catalogApi.items('minime'),
      ]);
      const [mine, visits] = await Promise.all([
        viewerName && !view.isOwner ? homeApi.get(viewerName).catch(() => null) : null,
        homeApi.visit(username, visitorId()).catch(() => view.visits),
      ]);
      if (controller.signal.aborted) return;
      const viewerMinime = view.isOwner ? view.profile.minime : (mine?.profile.minime ?? 'man');
      prefetchModels([catalog.items.find((item) => item.id === viewerMinime)?.modelUrl ?? modelUrl('man')]);
      setLoaded({ view: { ...view, visits }, minimes: catalog.items, viewerMinime });
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setProblem(
        error instanceof ApiRequestError
          ? { status: error.status, message: error.message }
          : { status: 0, message: '미니홈피를 불러오지 못했어요' },
      );
    });
    return () => controller.abort();
  }, [username, status, viewerName]);

  if (problem) {
    return (
      <main className="page page--center">
        <section className="page-card">
          <h1>
            {problem.status === 404
              ? '없는 미니홈피예요'
              : problem.status === 403
                ? '비공개 미니홈피예요'
                : '불러오지 못했어요'}
          </h1>
          <p className="page-muted">{problem.message}</p>
          <div className="page-actions">
            <Link className="page-button" to="/explore">
              둘러보기
            </Link>
            {!user && (
              <Link className="page-button page-button--ghost" to="/">
                로그인
              </Link>
            )}
          </div>
        </section>
      </main>
    );
  }
  if (!loaded) return <Loading />;
  return (
    <Suspense fallback={<Loading />}>
      <Minihome
        key={username}
        view={loaded.view}
        viewer={user}
        viewerMinime={loaded.viewerMinime}
        minimes={loaded.minimes}
        onView={(view) =>
          setLoaded(
            (current) =>
              current && { ...current, view, viewerMinime: view.isOwner ? view.profile.minime : current.viewerMinime },
          )
        }
        onLogout={() => logout().then(() => navigate('/'))}
      />
    </Suspense>
  );
}
