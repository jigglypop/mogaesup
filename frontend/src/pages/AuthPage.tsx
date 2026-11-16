import { useState, type FormEvent } from 'react';

import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';

import { problemText } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { hasUnsavedWork } from '../auth/sessionWork';
import { returnPath } from '../auth/signIn';
import { Icon } from '../ui/icons';
import { useTabs } from '../ui/tabs';
import { Loading } from './Loading';

type Mode = 'login' | 'signup';
const MODES: readonly Mode[] = ['login', 'signup'];
const OTHER_ACCOUNT_QUESTION = '저장하지 못한 변경이 있어요. 다른 계정으로 로그인하면 사라져요. 계속할까요?';

/**
 * `/`: sign in or sign up. Afterwards, and for a visitor already signed in, it goes back to `?next=` (a path on this
 * site the sign-in link came from) or else to their own island.
 */
export function AuthPage() {
  const { status, user, lapsed, login, register } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = returnPath(params.get('next'));
  const [mode, setMode] = useState<Mode>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The form is the panel of whichever tab is chosen. A sign-in error means nothing on the sign-up form, and the
  // other way round.
  const tabs = useTabs(
    MODES,
    mode,
    (chosen) => {
      setMode(chosen);
      setError('');
    },
    { sharedPanel: true },
  );

  if (status === 'loading') return <Loading />;
  if (user) return <Navigate to={next ?? `/@${user.username}`} replace />;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (key: string) => String(form.get(key) ?? '');
    // What the member whose session lapsed left unsaved waits for them; anyone else signing in drops it, so that asks.
    const username = field('username').trim().toLowerCase();
    const other = lapsed !== null && (mode === 'signup' || lapsed.username.toLowerCase() !== username);
    if (other && hasUnsavedWork() && !window.confirm(OTHER_ACCOUNT_QUESTION)) return;
    setBusy(true);
    setError('');
    try {
      const signedIn =
        mode === 'login'
          ? await login({ username, password: field('password') })
          : await register({
              username,
              displayName: field('displayName').trim(),
              password: field('password'),
            });
      navigate(next ?? `/@${signedIn.username}`, { replace: true });
    } catch (problem) {
      setError(problemText(problem));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mg-auth">
      <section className="mg-auth-card mg-glass">
        <h1 className="mg-auth-brand">
          <span className="mg-brand-mark" aria-hidden="true">
            <Icon name="island" />
          </span>
          모개숲
        </h1>
        <div className="mg-tabs" {...tabs.list}>
          {MODES.map((item) => (
            <button key={item} type="button" {...tabs.tab(item)}>
              {item === 'login' ? '로그인' : '가입하기'}
            </button>
          ))}
        </div>
        <form className="mg-auth-form" onSubmit={submit} {...tabs.panel(mode, { focusable: false })}>
          <label className="mg-label">
            아이디
            <input
              className="mg-field"
              name="username"
              required
              minLength={3}
              maxLength={20}
              pattern="[A-Za-z0-9_\-]+"
              title="영문, 숫자, 밑줄(_), 하이픈(-)"
              autoComplete="username"
              // Phone keyboards would capitalise and correct an id.
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          {mode === 'signup' && (
            <label className="mg-label">
              이름
              <input className="mg-field" name="displayName" required maxLength={20} autoComplete="nickname" />
            </label>
          )}
          <label className="mg-label">
            비밀번호
            <input
              className="mg-field"
              name="password"
              type="password"
              required
              minLength={mode === 'signup' ? 10 : 1}
              maxLength={128}
              placeholder={mode === 'signup' ? '10자 이상' : undefined}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          {error && (
            <p className="mg-error" role="alert">
              {error}
            </p>
          )}
          <button className="mg-btn is-primary is-wide" type="submit" disabled={busy}>
            {mode === 'login' ? '로그인' : '가입하고 내 섬 만들기'}
          </button>
        </form>
      </section>
    </main>
  );
}
