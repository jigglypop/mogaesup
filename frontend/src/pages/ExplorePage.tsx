import { useEffect, useRef, useState } from 'react';

import { Link, useSearchParams } from 'react-router-dom';

import { homeApi } from '../api/endpoints';
import type { HomeSummary } from '../api/types';
import { PageShell } from '../shell/Shell';
import { Icon } from '../ui/icons';
import { appendHomes, EXPLORE_PAGE, nextBefore, searchOf } from './explore';

/** How long the typing rests before the list asks the server. */
const SEARCH_REST_MS = 300;
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

/** Phones have no search in the top bar; this one narrows the list as you type. */
function ExploreSearch({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(query);
  // The address follows the typing a beat later; taking it back mid-typing would undo keystrokes and break Korean
  // composition, so only a change from elsewhere (while the field is idle) is copied in.
  useEffect(() => {
    if (document.activeElement !== input.current) setText(query);
  }, [query]);
  return (
    <label className="mg-search mg-explore-search">
      <Icon name="search" />
      <input
        ref={input}
        type="search"
        value={text}
        maxLength={40}
        placeholder="섬이나 사람 찾기"
        aria-label="섬이나 사람 찾기"
        enterKeyHint="search"
        onChange={(event) => {
          setText(event.target.value);
          onQuery(event.target.value);
        }}
        // The keyboard's search key puts the keyboard away, uncovering the islands.
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
      />
    </label>
  );
}

/** `value` once it has stayed the same for `ms`. */
function useRested<T>(value: T, ms: number): T {
  const [rested, setRested] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setRested(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return rested;
}

/** `/explore`: public islands, most recently changed first, found by `?q` on the server and a page at a time. */
export function ExplorePage() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const search = useRested(searchOf(query), SEARCH_REST_MS);
  const [homes, setHomes] = useState<HomeSummary[] | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  // Another search drops whatever is still on its way for the one before it.
  const asking = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    asking.current = controller;
    setLoadingMore(false);
    homeApi.list({ limit: EXPLORE_PAGE, q: search }, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setHomes(result.homes);
        setBefore(nextBefore(result.homes));
        setError('');
      },
      () => {
        if (controller.signal.aborted) return;
        // What stays on screen would be the answer to an earlier search.
        setHomes(null);
        setBefore(null);
        setError('목록을 불러오지 못했어요');
      },
    );
    return () => controller.abort();
  }, [search]);

  const loadMore = () => {
    const controller = asking.current;
    if (!before || !controller || loadingMore) return;
    setLoadingMore(true);
    setError('');
    homeApi.list({ limit: EXPLORE_PAGE, q: search, before }, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setHomes((current) => appendHomes(current ?? [], result.homes));
        setBefore(nextBefore(result.homes));
        setLoadingMore(false);
      },
      () => {
        if (controller.signal.aborted) return;
        setError('목록을 불러오지 못했어요');
        setLoadingMore(false);
      },
    );
  };

  return (
    <PageShell title="둘러보기">
      <section className="mg-glass mg-panel">
        <div className="mg-panel-head">
          <h1 className="mg-title">둘러보기</h1>
          {query && (
            <span className="mg-chip mg-explore-query">
              &lsquo;{query}&rsquo; 찾는 중
              <button className="mg-icon-btn is-quiet" aria-label="찾기 지우기" onClick={() => setParams({})}>
                <Icon name="close" />
              </button>
            </span>
          )}
          <ExploreSearch query={query} onQuery={(text) => setParams(text ? { q: text } : {}, { replace: true })} />
        </div>
        {error && <p className="mg-error">{error}</p>}
        {homes?.length === 0 && <p className="mg-empty">{search ? '찾는 섬이 없어요' : '아직 공개된 섬이 없어요'}</p>}
        <ul className="mg-islands">
          {homes?.map((home) => {
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
        {before && (
          <button className="mg-btn is-quiet is-wide" disabled={loadingMore} onClick={loadMore}>
            더 보기
          </button>
        )}
      </section>
    </PageShell>
  );
}
