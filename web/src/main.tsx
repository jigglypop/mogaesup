import './app.css';
import './pages/pages.css';

import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';

import { AuthProvider } from './auth/AuthProvider';
import { AdminPage } from './pages/AdminPage';
import { AuthPage } from './pages/AuthPage';
import { ExplorePage } from './pages/ExplorePage';
import { MinihomePage } from './pages/MinihomePage';

/** `/@username` is a minihome; any other single segment is not a page. */
function UsernameRoute() {
  const { slug = '' } = useParams();
  return slug.startsWith('@') && slug.length > 1 ? (
    <MinihomePage username={slug.slice(1).toLowerCase()} />
  ) : (
    <Navigate to="/" replace />
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<AuthPage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/:slug" element={<UsernameRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>,
  );
}
