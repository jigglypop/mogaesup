import { useEffect, useState } from 'react';

import { Link } from 'react-router-dom';

import { homeApi } from '../api/endpoints';
import type { HomeSummary } from '../api/types';
import { useAuth } from '../auth/AuthProvider';

/** `/explore`: public minihomes, most recently changed first. */
export function ExplorePage() {
  const { user } = useAuth();
  const [homes, setHomes] = useState<HomeSummary[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    homeApi.list().then(
      (result) => setHomes(result.homes),
      () => setError('목록을 불러오지 못했어요'),
    );
  }, []);

  return (
    <main className="page">
      <header className="page-header">
        <Link className="page-brand" to="/">
          🏝️ 모개숲
        </Link>
        <nav className="page-actions">
          {user ? (
            <Link className="page-button" to={`/@${user.username}`}>
              내 미니홈피
            </Link>
          ) : (
            <Link className="page-button" to="/">
              로그인
            </Link>
          )}
        </nav>
      </header>
      {error && <p className="page-error">{error}</p>}
      {homes?.length === 0 && <p className="page-muted">아직 공개된 미니홈피가 없어요</p>}
      <ul className="page-grid">
        {homes?.map((home) => (
          <li key={home.username}>
            <Link className="home-card" to={`/@${home.username}`}>
              <span className="home-card__face">{home.emoji}</span>
              <b>{home.title}</b>
              <small>
                {home.ownerName} · @{home.username}
              </small>
              {home.statusMessage && <p>{home.statusMessage}</p>}
              <span className="home-card__total">TOTAL {home.total.toLocaleString()}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
