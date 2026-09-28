import { useEffect, useMemo, useState } from 'react';

import { Link, useSearchParams } from 'react-router-dom';

import { homeApi } from '../api/endpoints';
import type { HomeSummary } from '../api/types';
import { PageShell } from '../shell/Shell';
import { Icon } from '../ui/icons';

const SKIES = [
  ['#cfe8f7', '#bfe3b4'],
  ['#fde3d3', '#d6ecbf'],
  ['#e5defc', '#c8e6c4'],
  ['#fff0c9', '#c9e5b6'],
  ['#d7f0ea', '#b9dcb0'],
] as const;
const skyOf = (username: string) => SKIES[[...username].reduce((sum, char) => sum + char.charCodeAt(0), 0) % SKIES.length]!;
const since = (at: string) => {
  const days = Math.floor((Date.now() - Date.parse(at)) / 86_400_000);
  if (days < 1) return '오늘 바뀜';
  if (days < 7) return `${days}일 전 바뀜`;
  return new Date(at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
};

/** `/explore`: public islands, most recently changed first, filtered by `?q`. */
export function ExplorePage() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const [homes, setHomes] = useState<HomeSummary[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    homeApi.list().then(
      (result) => setHomes(result.homes),
      () => setError('목록을 불러오지 못했어요'),
    );
  }, []);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !homes) return homes;
    return homes.filter((home) =>
      [home.username, home.ownerName, home.title, home.statusMessage].some((text) => text.toLowerCase().includes(needle)),
    );
  }, [homes, query]);

  return (
    <PageShell title="둘러보기">
      <section className="mg-glass mg-panel">
        <div className="mg-panel-head">
          <h1 className="mg-title">둘러보기</h1>
          {query && (
            <span className="mg-chip">
              &lsquo;{query}&rsquo; 찾는 중
              <button className="mg-icon-btn is-quiet" aria-label="찾기 지우기" onClick={() => setParams({})}>
                <Icon name="close" />
              </button>
            </span>
          )}
        </div>
        {error && <p className="mg-error">{error}</p>}
        {shown?.length === 0 && <p className="mg-empty">{query ? '찾는 섬이 없어요' : '아직 공개된 섬이 없어요'}</p>}
        <ul className="mg-islands">
          {shown?.map((home) => {
            const [top, bottom] = skyOf(home.username);
            return (
              <li key={home.username}>
                <Link className="mg-island-card mg-card" to={`/@${home.username}`}>
                  <span className="mg-island-sky" style={{ background: `linear-gradient(180deg, ${top}, ${bottom})` }} aria-hidden="true">
                    <span>{home.emoji}</span>
                  </span>
                  <span className="mg-island-info">
                    <b>{home.title}</b>
                    <small>
                      {home.ownerName} · @{home.username}
                    </small>
                    {home.statusMessage && <span className="mg-island-status">{home.statusMessage}</span>}
                    <span className="mg-island-meta">
                      <span>{since(home.updatedAt)}</span>
                      <span>방문 {home.total.toLocaleString()}</span>
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </PageShell>
  );
}
