import { useState, type FormEvent } from 'react';

import { Link, Navigate, useNavigate } from 'react-router-dom';

import { problemText } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Loading } from './Loading';

type Mode = 'login' | 'signup';

/** `/`: sign in or sign up; a signed-in visitor goes straight to their own minihome. */
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
    <main className="page page--center">
      <section className="page-card page-card--auth">
        <h1 className="page-brand">🏝️ 모개숲</h1>
        <div className="page-segment" role="tablist">
          {(['login', 'signup'] as const).map((item) => (
            <button key={item} role="tab" aria-selected={mode === item} onClick={() => setMode(item)}>
              {item === 'login' ? '로그인' : '가입하기'}
            </button>
          ))}
        </div>
        <form className="page-form" onSubmit={submit}>
          <label>
            아이디
            <input
              name="username"
              required
              minLength={3}
              maxLength={20}
              pattern="[A-Za-z0-9_\-]+"
              title="영문, 숫자, 밑줄(_), 하이픈(-)"
              autoComplete="username"
            />
          </label>
          {mode === 'signup' && (
            <label>
              이름
              <input name="displayName" required maxLength={20} autoComplete="nickname" />
            </label>
          )}
          <label>
            비밀번호
            <input
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
            <p className="page-error" role="alert">
              {error}
            </p>
          )}
          <button className="page-button" type="submit" disabled={busy}>
            {mode === 'login' ? '로그인' : '가입하고 미니홈피 만들기'}
          </button>
        </form>
        <Link className="page-link" to="/explore">
          미니홈피 둘러보기
        </Link>
      </section>
    </main>
  );
}
