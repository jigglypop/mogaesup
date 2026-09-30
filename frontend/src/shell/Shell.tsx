import './shell.css';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Link, useLocation, useNavigate } from 'react-router-dom';

import { problemText } from '../api/client';
import { socialApi } from '../api/endpoints';
import type { IlchonRequest } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/can';
import { Icon, type IconName } from '../ui/icons';
import { useTheme, type ThemeChoice } from '../ui/theme';

/** Open state for a menu that closes on Escape or a press outside it. */
export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** Fired when 이웃 requests change elsewhere on the page, so the bell counts again. */
export const REQUESTS_CHANGED = 'mogaesup:requests';

export const initialOf = (name: string) => [...name.trim()][0] ?? '?';
/** A stable pastel for someone's initial tile. */
export const toneOf = (key: string) => String([...key].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4);

export function Brand() {
  const { user } = useAuth();
  return (
    <Link className="mg-brand" to={user ? `/@${user.username}` : '/'} aria-label="모개숲 처음으로">
      <span className="mg-brand-mark" aria-hidden="true">
        <Icon name="island" />
      </span>
      <b>모개숲</b>
    </Link>
  );
}

type RailItem = { label: string; icon: IconName; to: string; active: boolean; divided?: boolean };

/** The app's five places. Signed-out visitors get the island list and the way in. */
export function Rail() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const home = user ? `/@${user.username}` : '/';
  const items: RailItem[] = [
    { label: '섬', icon: 'island', to: home, active: !!user && pathname === home },
    ...(user
      ? [
          { label: '꾸미기', icon: 'brush' as const, to: `${home}/edit`, active: pathname === `${home}/edit` },
          { label: '캐릭터', icon: 'person' as const, to: '/character', active: pathname.startsWith('/character') },
        ]
      : []),
    { label: '둘러보기', icon: 'compass', to: '/explore', active: pathname.startsWith('/explore') },
    ...(can(user, 'catalog_editor')
      ? [{ label: '운영', icon: 'shield' as const, to: '/admin', active: pathname.startsWith('/admin'), divided: true }]
      : []),
  ];
  return (
    <nav className="mg-rail mg-glass" aria-label="모개숲">
      {items.map((item) => (
        <Link
          key={item.label}
          className={item.divided ? 'is-divided' : undefined}
          to={item.to}
          aria-current={item.active ? 'page' : undefined}
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}

function SearchBox() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = text.trim();
    navigate(query ? `/explore?q=${encodeURIComponent(query)}` : '/explore');
  };
  return (
    <form className="mg-search" role="search" onSubmit={submit}>
      <Icon name="search" />
      <input
        value={text}
        maxLength={40}
        placeholder="섬이나 사람 찾기"
        aria-label="섬이나 사람 찾기"
        enterKeyHint="search"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
      />
    </form>
  );
}

/** 이웃 requests waiting for the viewer, with accept and decline in place. */
function Notifications() {
  const { user } = useAuth();
  const { open, setOpen, ref } = usePopover();
  const [received, setReceived] = useState<IlchonRequest[]>([]);
  const [error, setError] = useState('');
  const reload = useCallback(
    () =>
      socialApi.requests().then(
        (result) => setReceived(result.received),
        () => setReceived([]),
      ),
    [],
  );
  useEffect(() => {
    if (!user) return undefined;
    void reload();
    const timer = setInterval(() => void reload(), 60_000);
    const changed = () => void reload();
    window.addEventListener(REQUESTS_CHANGED, changed);
    return () => {
      clearInterval(timer);
      window.removeEventListener(REQUESTS_CHANGED, changed);
    };
  }, [user, reload]);
  if (!user) return null;
  const act = (action: () => Promise<unknown>) => {
    setError('');
    action()
      .then(() => window.dispatchEvent(new Event(REQUESTS_CHANGED)))
      .catch((problem: unknown) => setError(problemText(problem)));
  };
  return (
    <div className="mg-anchor" ref={ref}>
      <button
        className="mg-icon-btn"
        aria-label={received.length ? `알림 ${received.length}개` : '알림'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="bell" />
        {received.length > 0 && <span className="mg-count">{received.length}</span>}
      </button>
      {open && (
        <div className="mg-popover mg-menu is-right" role="dialog" aria-label="알림">
          <p className="mg-menu-title">이웃 신청</p>
          {received.length === 0 && <p className="mg-empty">새 알림이 없어요</p>}
          <ul className="mg-requests">
            {received.map((request) => (
              <li key={request.id}>
                <Link className="mg-avatar" data-tone={toneOf(request.from.username)} to={`/@${request.from.username}`}>
                  {initialOf(request.from.displayName)}
                </Link>
                <div>
                  <b>{request.from.displayName}</b>
                  <small>{request.message || `'${request.theirName}'로 불러 달래요`}</small>
                </div>
                <span>
                  <button className="mg-btn is-primary is-small" onClick={() => act(() => socialApi.accept(request.id, {}))}>
                    수락
                  </button>
                  <button className="mg-btn is-quiet is-small" onClick={() => act(() => socialApi.dismiss(request.id))}>
                    거절
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {error && <p className="mg-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: '밝게' },
  { value: 'dark', label: '어둡게' },
  { value: 'system', label: '기기 설정' },
];

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { open, setOpen, ref } = usePopover();
  const [theme, setTheme] = useTheme();
  if (!user) {
    return (
      <Link className="mg-btn is-primary" to="/">
        로그인
      </Link>
    );
  }
  const home = `/@${user.username}`;
  return (
    <div className="mg-anchor" ref={ref}>
      <button className="mg-me" aria-label="내 메뉴" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="mg-avatar is-round" data-tone={toneOf(user.username)}>
          {initialOf(user.displayName)}
        </span>
      </button>
      {open && (
        <div className="mg-popover mg-menu is-right" role="menu" aria-label="내 메뉴">
          <div className="mg-menu-who">
            <b>{user.displayName}</b>
            <small>@{user.username}</small>
            {user.role === 'admin' && <span className="mg-badge is-admin">관리자</span>}
          </div>
          <Link role="menuitem" to={home} onClick={() => setOpen(false)}>
            <Icon name="island" /> 내 섬
          </Link>
          <Link role="menuitem" to={`${home}/edit`} onClick={() => setOpen(false)}>
            <Icon name="brush" /> 섬 꾸미기
          </Link>
          <Link role="menuitem" to="/character" onClick={() => setOpen(false)}>
            <Icon name="person" /> 내 캐릭터
          </Link>
          <div className="mg-menu-row">
            <span>화면</span>
            <div className="mg-tabs" role="radiogroup" aria-label="화면 밝기">
              {THEMES.map((option) => (
                <button key={option.value} role="radio" aria-checked={theme === option.value} onClick={() => setTheme(option.value)}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <button role="menuitem" onClick={() => void logout().then(() => navigate('/'))}>
            <Icon name="logout" /> 로그아웃
          </button>
        </div>
      )}
    </div>
  );
}

/** The right end of every top bar: search, notifications and the viewer. */
export function TopActions({ search = true, children }: { search?: boolean; children?: ReactNode }) {
  return (
    <div className="mg-topbar-right">
      {children}
      {search && <SearchBox />}
      <Notifications />
      <UserMenu />
    </div>
  );
}

/** Screens that are not the world: the rail, a top bar and one large glass panel. */
export function PageShell({ title, children, wide = false }: { title: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="mg-app is-page">
      <header className="mg-topbar">
        <div className="mg-topbar-left">
          <Brand />
          <span className="mg-pill mg-glass">{title}</span>
        </div>
        <TopActions />
      </header>
      <Rail />
      <main className={`mg-page-main${wide ? ' is-wide' : ''}`}>{children}</main>
    </div>
  );
}
