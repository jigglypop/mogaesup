import './shell.css';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { flushSync } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { problemText } from '../api/client';
import { socialApi } from '../api/endpoints';
import type { IlchonRequest, User } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { useSignInPath } from '../auth/signIn';
import { can } from '../auth/can';
import { saveUnsavedWork } from '../auth/sessionWork';
import { Icon } from '../ui/icons';
import { useTheme, type ThemeChoice } from '../ui/theme';
import { leaveFor } from './leaving';
import { PasswordDialog, type PasswordAction } from './PasswordDialog';

/** Where an arrow, Home or End key moves to in a menu of `count` items from `index` (-1: none focused yet). */
export function nextMenuIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count;
  if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * Open state for a popover beside its button (`ref` goes on the element holding both). Opening moves the keyboard into
 * it: to a menu's first item, or onto a dialog itself. Escape closes it and gives focus back to the button; a press
 * outside, or Tab past its end, closes it. In a menu (role=menu) the up and down arrows, Home and End move between items.
 */
export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);
  useEffect(() => {
    const anchor = ref.current;
    if (!open || !anchor) return undefined;
    const focused = document.activeElement;
    const trigger = focused instanceof HTMLElement && anchor.contains(focused) ? focused : anchor.querySelector<HTMLElement>('[aria-expanded]');
    const popover = anchor.querySelector<HTMLElement>('.mg-popover');
    const menu = popover?.matches('[role="menu"]') ? popover : popover?.querySelector<HTMLElement>('[role="menu"]');
    const items = () => (menu ? [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')] : []);
    (items()[0] ?? popover)?.focus();
    const outside = (event: PointerEvent) => {
      if (!anchor.contains(event.target as Node)) setOpen(false);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger?.focus();
        return;
      }
      if (!menu?.contains(document.activeElement)) return;
      const list = items();
      const next = nextMenuIndex(event.key, list.indexOf(document.activeElement as HTMLElement), list.length);
      if (next === null) return;
      event.preventDefault();
      list[next]?.focus();
    };
    const left = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && !anchor.contains(event.relatedTarget)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keys);
    anchor.addEventListener('focusout', left);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keys);
      anchor.removeEventListener('focusout', left);
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

/**
 * Where the operators' pages open for `user`: the catalog for catalog editors, the character factory for operators (paid
 * operators are operators too), and null for anyone with neither.
 */
export function adminHome(user: User | null | undefined): string | null {
  if (can(user, 'catalog_editor')) return '/admin';
  if (can(user, 'operator')) return '/admin/studio';
  return null;
}

/**
 * The walking island's rail (`minihome/`, kept off the screens): the way to one's own home, or in. The screens have
 * none, since the brand already leads there and the top bar's search finds the rest; other places open by address.
 */
export function Rail() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const home = user ? `/@${user.username}` : '/';
  const here = !!user && (pathname === home || pathname.startsWith(`${home}/`));
  return (
    <nav className="mg-rail mg-glass" aria-label="모개숲">
      <Link to={home} aria-current={here ? 'page' : undefined}>
        <Icon name="home" />
        <span>사주 마을</span>
      </Link>
    </nav>
  );
}

/**
 * The top bar's search: the box where the bar has room for it, and on a phone a button that opens the box over the bar,
 * the keyboard with it (see shell.css). Opened so, it folds away with its close button or Escape, or once the focus
 * leaves it, keeping what was typed: the bar's own buttons under it are never focused unseen. Enter opens 둘러보기 on
 * what was typed, the way a link there would (`leaveFor`).
 */
export function SearchBox() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const boxId = useId();
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = text.trim();
    setOpen(false);
    leaveFor(query ? `/explore?q=${encodeURIComponent(query)}` : '/explore', navigate);
  };
  // The box is shown before it takes the focus, within the press: a phone brings its keyboard up for a field focused then.
  const show = () => {
    flushSync(() => setOpen(true));
    field.current?.focus();
  };
  // The button stands where it was once the box is gone, and takes the keyboard back.
  const fold = () => {
    flushSync(() => setOpen(false));
    opener.current?.focus();
  };
  return (
    <>
      <button ref={opener} type="button" className="mg-icon-btn mg-search-open" aria-label="섬이나 사람 찾기" aria-expanded={open} aria-controls={boxId} onClick={show}>
        <Icon name="search" />
      </button>
      <form
        id={boxId}
        className={`mg-search${open ? ' is-open' : ''}`}
        role="search"
        onSubmit={submit}
        onBlur={(event) => {
          if (open && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        <Icon name="search" />
        <input
          ref={field}
          value={text}
          maxLength={40}
          placeholder="섬이나 사람 찾기"
          aria-label="섬이나 사람 찾기"
          enterKeyHint="search"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape' && open) {
              event.preventDefault();
              fold();
            }
          }}
        />
        {/* A press on it leaves the focus in the field, so the box is folded by the press and not before it. */}
        <button type="button" className="mg-icon-btn is-quiet mg-search-close" aria-label="찾기 닫기" onMouseDown={(event) => event.preventDefault()} onClick={fold}>
          <Icon name="close" />
        </button>
      </form>
    </>
  );
}

/** 이웃 requests waiting for the viewer, with accept and decline in place. */
function Notifications() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { open, setOpen, ref } = usePopover();
  const popoverId = useId();
  const [received, setReceived] = useState<IlchonRequest[]>([]);
  const [error, setError] = useState('');
  const viewing = useRef(userId);
  viewing.current = userId;
  // Each member's own list: another one signing in starts empty, and answers to the one before are dropped.
  useEffect(() => {
    setReceived([]);
    setError('');
    setOpen(false);
    if (!userId) return undefined;
    let live = true;
    const reload = () =>
      socialApi.requests().then(
        (result) => {
          if (live) setReceived(result.received);
        },
        () => {
          if (live) setReceived([]);
        },
      );
    void reload();
    // A hidden tab skips the minute's check and makes it up as soon as it is shown again.
    let missed = false;
    const timer = setInterval(() => {
      if (document.hidden) missed = true;
      else void reload();
    }, 60_000);
    const shown = () => {
      if (document.hidden || !missed) return;
      missed = false;
      void reload();
    };
    const changed = () => void reload();
    window.addEventListener(REQUESTS_CHANGED, changed);
    document.addEventListener('visibilitychange', shown);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener(REQUESTS_CHANGED, changed);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [userId, setOpen]);
  if (!user) return null;
  const act = (action: () => Promise<unknown>) => {
    const mine = userId;
    setError('');
    action()
      .then(() => window.dispatchEvent(new Event(REQUESTS_CHANGED)))
      .catch((problem: unknown) => {
        if (viewing.current === mine) setError(problemText(problem));
      });
  };
  return (
    <div className="mg-anchor" ref={ref}>
      <button
        className="mg-icon-btn"
        aria-label={received.length ? `알림 ${received.length}개` : '알림'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="bell" />
        {received.length > 0 && <span className="mg-count">{received.length}</span>}
      </button>
      {open && (
        <div id={popoverId} className="mg-popover mg-menu is-right" role="dialog" aria-label="알림" tabIndex={-1}>
          <p className="mg-menu-title">이웃 신청</p>
          {received.length === 0 && <p className="mg-empty">새 알림이 없어요</p>}
          {received.length > 1 && (
            <button className="mg-btn is-quiet is-small" onClick={() => act(() => socialApi.dismissAll())}>
              모두 거절
            </button>
          )}
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
          {error && <p className="mg-error" role="alert">{error}</p>}
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

/** Signing out drops what is held for the member here; it asks first when that loses edits nobody saved. */
const UNSAVED_QUESTION = '저장하지 못한 변경이 있어요. 로그아웃하면 사라져요. 계속할까요?';

function UserMenu() {
  const { user, lapsed, logout } = useAuth();
  const navigate = useNavigate();
  const signIn = useSignInPath();
  const { open, setOpen, ref } = usePopover();
  const trigger = useRef<HTMLButtonElement>(null);
  const [theme, setTheme] = useTheme();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');
  /** What the password dialog is open for, if it is. */
  const [password, setPassword] = useState<PasswordAction | null>(null);
  const pending = useRef(false);
  const userId = user?.id ?? null;
  useEffect(() => {
    setError('');
    setPassword(null);
  }, [userId]);
  // What went wrong last time is not news when the menu opens again.
  useEffect(() => {
    if (!open) return;
    setError('');
  }, [open]);
  const ask = (action: PasswordAction) => {
    // Closing the dialog hands the keyboard back to the menu's button.
    trigger.current?.focus();
    setOpen(false);
    setPassword(action);
  };
  const signOut = async () => {
    if (pending.current) return;
    pending.current = true;
    setLeaving(true); setError('');
    try {
      // Edits not saved yet are saved before the session ends; it asks only about what still could not be.
      if (!(await saveUnsavedWork()) && !window.confirm(UNSAVED_QUESTION)) return;
      await logout(); setOpen(false); navigate('/');
    }
    catch (problem) { setError(problemText(problem)); }
    finally { pending.current = false; setLeaving(false); }
  };
  if (!user) {
    return (
      <>
        <Link className="mg-btn is-primary" to={signIn}>
          로그인
        </Link>
        {/* A session that ran out still holds its member's work here until someone signs in or out. */}
        {lapsed && (
          <button className="mg-btn is-quiet" disabled={leaving} onClick={() => void signOut()}>
            {leaving ? '로그아웃 중…' : '로그아웃'}
          </button>
        )}
        {lapsed && error && <p className="mg-error" role="alert">{error}</p>}
      </>
    );
  }
  const home = `/@${user.username}`;
  return (
    <div className="mg-anchor" ref={ref}>
      <button ref={trigger} className="mg-me" aria-label="내 메뉴" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="mg-avatar is-round" data-tone={toneOf(user.username)}>
          {initialOf(user.displayName)}
        </span>
      </button>
      {open && (
        <div className="mg-popover mg-menu is-right">
          <div className="mg-menu-who">
            <b>{user.displayName}</b>
            <small>@{user.username}</small>
            {user.role === 'admin' && <span className="mg-badge is-admin">관리자</span>}
          </div>
          <div className="mg-menu-items" role="menu" aria-label="내 메뉴">
            <Link role="menuitem" to={home} onClick={() => setOpen(false)}>
              <Icon name="home" /> 내 집
            </Link>
            <div className="mg-menu-row" role="group" aria-label="화면 밝기">
              <span aria-hidden="true">화면</span>
              <div className="mg-tabs">
                {THEMES.map((option) => (
                  <button key={option.value} role="menuitemradio" aria-checked={theme === option.value} onClick={() => setTheme(option.value)}>
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <button role="menuitem" aria-haspopup="dialog" onClick={() => ask('change')}>
              <Icon name="edit" /> 비밀번호 바꾸기
            </button>
            <button role="menuitem" aria-haspopup="dialog" onClick={() => ask('others')}>
              <Icon name="logout" /> 다른 기기에서 모두 로그아웃
            </button>
            <button role="menuitem" aria-disabled={leaving || undefined} onClick={() => void signOut()}>
              <Icon name="logout" /> {leaving ? '로그아웃 중…' : '로그아웃'}
            </button>
          </div>
          {/* A menu holds only its items; what went wrong with one is said beside it. */}
          {error && <p className="mg-error mg-menu-error" role="alert">{error}</p>}
        </div>
      )}
      {password && <PasswordDialog action={password} onClose={() => setPassword(null)} />}
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

/** Screens that are not the world: a top bar and one large glass panel. */
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
      <main className={`mg-page-main${wide ? ' is-wide' : ''}`}>{children}</main>
    </div>
  );
}
