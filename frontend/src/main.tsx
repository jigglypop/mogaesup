import './ui/tokens.css';
import './ui/ui.css';
import './pages/pages.css';

import { lazy, Suspense } from 'react';

import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';

import { AuthProvider, useAuth } from './auth/AuthProvider';
import { AuthPage } from './pages/AuthPage';
import { ExplorePage } from './pages/ExplorePage';
import { Loading } from './pages/Loading';
import { isMinihomePage, movedPath } from './saju/routes';
import { AppErrorBoundary } from './ui/ErrorBoundary';
import { initTheme } from './ui/theme';
import { routeOf } from './studio/screens';

initTheme();

// The character studio brings its own screens and 3D viewer; it loads only when someone opens it.
const StudioPage = lazy(() => import('./studio/StudioPage'));
const CharacterPage = lazy(() => import('./studio/CharacterPage'));
// Only catalog editors open the pipeline board and only admins the permissions, so members never download them.
const AdminPage = lazy(() => import('./pages/AdminPage').then((module) => ({ default: module.AdminPage })));
const PermissionsPage = lazy(() => import('./pages/permissions/PermissionsPage'));
// A 미니홈피 brings its own 3D scene and the chart calculation; they load with the first one opened.
const SajuPage = lazy(() => import('./saju/SajuPage'));

/** Old studio addresses: the wardrobe is `/character` now, the factory screens live under `/admin/studio`. */
function StudioRedirect() {
  const { '*': rest = '' } = useParams();
  const { search, hash } = useLocation();
  const target = rest ? `/admin/studio/${rest}${search}` : routeOf(`/${search}`) ?? `/character${search}`;
  return <Navigate to={`${target}${hash}`} replace />;
}

/** `/@username` is a member's 미니홈피, with its village and (for its owner) the form its home is built from. */
function UsernameRoute() {
  const { slug = '', '*': rest = '' } = useParams();
  const page = rest.replace(/\/+$/, '');
  if (!slug.startsWith('@') || slug.length < 2 || !isMinihomePage(page)) return <Navigate to="/" replace />;
  const username = slug.slice(1).toLowerCase();
  return (
    <Suspense fallback={<Loading />}>
      <SajuPage key={username} username={username} rest={page} />
    </Suspense>
  );
}

/** `/saju/*`, where the 사주 village first stood: on to the same page of the viewer's own 미니홈피. */
function SajuRedirect() {
  const { '*': rest = '' } = useParams();
  const { search } = useLocation();
  const { status, user } = useAuth();
  if (status === 'loading') return <Loading />;
  return <Navigate to={user ? movedPath(user.username, rest, search) : '/'} replace />;
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <AppErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<AuthPage />} />
            <Route path="/explore" element={<ExplorePage />} />
            <Route
              path="/character"
              element={
                <Suspense fallback={<Loading />}>
                  <CharacterPage />
                </Suspense>
              }
            />
            <Route path="/studio/*" element={<StudioRedirect />} />
            <Route
              path="/admin/studio/*"
              element={
                <Suspense fallback={<Loading />}>
                  <StudioPage />
                </Suspense>
              }
            />
            <Route
              path="/admin/permissions"
              element={
                <Suspense fallback={<Loading />}>
                  <PermissionsPage />
                </Suspense>
              }
            />
            <Route
              path="/admin/*"
              element={
                <Suspense fallback={<Loading />}>
                  <AdminPage />
                </Suspense>
              }
            />
            <Route path="/saju/*" element={<SajuRedirect />} />
            <Route path="/:slug/*" element={<UsernameRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </AppErrorBoundary>,
  );
}
