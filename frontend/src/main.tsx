import './ui/tokens.css';
import './ui/ui.css';
import './pages/pages.css';

import { lazy, Suspense } from 'react';

import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';

import { AuthProvider } from './auth/AuthProvider';
import { AuthPage } from './pages/AuthPage';
import { ExplorePage } from './pages/ExplorePage';
import { Loading } from './pages/Loading';
import { MinihomePage } from './pages/MinihomePage';
import { AppErrorBoundary } from './ui/ErrorBoundary';
import { initTheme } from './ui/theme';

initTheme();

// The character studio brings its own screens and 3D viewer; it loads only when someone opens it.
const StudioPage = lazy(() => import('./studio/StudioPage'));
const CharacterPage = lazy(() => import('./studio/CharacterPage'));
// Only catalog editors open the pipeline board and only admins the permissions, so members never download them.
const AdminPage = lazy(() => import('./pages/AdminPage').then((module) => ({ default: module.AdminPage })));
const PermissionsPage = lazy(() => import('./pages/permissions/PermissionsPage'));

/** Old studio addresses: the wardrobe is `/character` now, the factory screens live under `/admin/studio`. */
function StudioRedirect() {
  const { '*': rest = '' } = useParams();
  return <Navigate to={rest ? `/admin/studio/${rest}` : '/character'} replace />;
}

/** `/@username` is an island and `/@username/edit` its decorating mode; any other single segment is not a page. */
function UsernameRoute() {
  const { slug = '', '*': rest = '' } = useParams();
  if (!slug.startsWith('@') || slug.length < 2 || (rest !== '' && rest !== 'edit')) return <Navigate to="/" replace />;
  return <MinihomePage username={slug.slice(1).toLowerCase()} editing={rest === 'edit'} />;
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
            <Route path="/:slug/*" element={<UsernameRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </AppErrorBoundary>,
  );
}
