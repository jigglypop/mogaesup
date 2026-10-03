import './admin-tabs.css';

import { Link, useLocation } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/can';

/** The 운영 pages, each shown to whoever may use it. */
export function AdminTabs() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const tabs = [
    { to: '/admin', label: '캐릭터 가져오기', open: can(user, 'catalog_editor') },
    { to: '/admin/catalog', label: '카탈로그', open: can(user, 'catalog_editor') },
    { to: '/admin/permissions', label: '권한', open: can(user, 'admin') },
    { to: '/admin/studio', label: '캐릭터 공장', open: can(user, 'operator') },
  ].filter((tab) => tab.open);
  const current = ['/admin/catalog', '/admin/permissions', '/admin/studio'].find((path) => pathname.startsWith(path)) ?? '/admin';
  return (
    <nav className="mg-tabs is-fit mg-admin-tabs" aria-label="운영">
      {tabs.map((tab) => (
        <Link key={tab.to} to={tab.to} aria-current={tab.to === current ? 'page' : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
