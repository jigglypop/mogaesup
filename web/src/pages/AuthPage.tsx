import { useState, type FormEvent } from 'react';

import { Link, Navigate, useNavigate } from 'react-router-dom';

import { problemText } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../ui/icons';
import { Loading } from './Loading';

type Mode = 'login' | 'signup';

/** `/`: sign in or sign up; a signed-in visitor goes straight to their own island. */
export function AuthPage() {
  const { status, user, login, register } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (status === 'loading') return <Loading />;
  if (user) return <Navigate to={`/@${user.username}`} replace />;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (key: string) => String(form.get(key) ?? '');
    setBusy(true);
    setError('');
    try {
      const signedIn =
        mode === 'login'
          ? await login({ username: field('username').trim().toLowerCase(), password: field('password') })
          : await register({
              username: field('username').trim().toLowerCase(),
              displayName: field('displayName').trim(),
              password: field('password'),
            });
      navigate(`/@${signedIn.username}`);
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
        <div className="mg-tabs" role="tablist">
          {(['login', 'signup'] as const).map((item) => (
            <button
              key={item}
              role="tab"
              aria-selected={mode === item}
              onClick={() => {
                // A sign-in error means nothing on the sign-up form, and the other way round.
                setMode(item);
                setError('');
              }}
            >
              {item === 'login' ? '로그인' : '가입하기'}
            </button>
          ))}
        </div>
        <form className="mg-auth-form" onSubmit={submit}>
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
        <Link className="mg-btn is-quiet is-wide" to="/explore">
          <Icon name="compass" /> 섬 둘러보기
        </Link>
      </section>
    </main>
  );
}
