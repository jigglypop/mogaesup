import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { Link } from 'react-router-dom';

import { problemText } from '../api/client';
import { socialApi } from '../api/endpoints';
import type { GuestbookEntry, User } from '../api/types';
import { useSignInPath } from '../auth/signIn';
import { initialOf, toneOf } from '../shell/Shell';

const when = (at: string) => {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}시간 전`;
  if (minutes < 2880) return '어제';
  return new Date(at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
};

/** The island's guestbook: a note to leave at the top, then the notes, newest first. */
export function Guestbook({ username, viewer }: { username: string; viewer: User | null }) {
  const signIn = useSignInPath();
  const [entries, setEntries] = useState<GuestbookEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [secret, setSecret] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const context = useRef<{ controller: AbortController; reads: number; paging: boolean; mutating: boolean } | null>(null);

  const load = useCallback(
    async (before?: string) => {
      const scope = context.current;
      if (!scope || scope.controller.signal.aborted || (before && scope.paging)) return;
      const mine = ++scope.reads;
      scope.paging = true;
      setLoading(true);
      try {
        const page = await socialApi.guestbook(username, before, scope.controller.signal);
        if (scope.controller.signal.aborted || mine !== scope.reads) return;
        setEntries((current) => before ? [...new Map([...current, ...page.entries].map(entry => [entry.id, entry])).values()] : page.entries);
        setTotal(page.total);
        setNextBefore(page.nextBefore);
      } finally {
        if (!scope.controller.signal.aborted && mine === scope.reads) { scope.paging = false; setLoading(false); }
      }
    },
    [username],
  );

  const run = (action: () => Promise<unknown>) => {
    const scope = context.current;
    setError('');
    action().catch((problem: unknown) => { if (scope && !scope.controller.signal.aborted) setError(problemText(problem)); });
  };

  useEffect(() => {
    const scope = { controller: new AbortController(), reads: 0, paging: false, mutating: false };
    context.current = scope;
    setEntries([]); setTotal(0); setNextBefore(null); setText(''); setSecret(false); setPosting(false); setError('');
    void load().catch((problem: unknown) => { if (!scope.controller.signal.aborted) setError(problemText(problem)); });
    return () => { scope.controller.abort(); };
  }, [load, viewer?.id]);

  const mutate = (action: (scope: NonNullable<typeof context.current>) => Promise<void>) => {
    const scope = context.current;
    if (!scope || scope.controller.signal.aborted || scope.mutating) return;
    scope.mutating = true;
    setPosting(true);
    run(() => action(scope).finally(() => {
      scope.mutating = false;
      if (!scope.controller.signal.aborted) setPosting(false);
    }));
  };

  // The island's owner may clear everything one visitor left at once.
  const owner = !!viewer && viewer.username === username;
  const removeAuthor = (entry: GuestbookEntry) => {
    if (!window.confirm(`${entry.author.displayName}의 글을 모두 지울까요?`)) return;
    mutate(async (scope) => {
      await socialApi.removeByAuthor(username, entry.author.username);
      if (scope.controller.signal.aborted) return;
      await load();
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;
    mutate(async (scope) => {
      await socialApi.write(username, { body, secret });
      if (scope.controller.signal.aborted) return;
      setText('');
      setSecret(false);
      await load();
    });
  };

  return (
    <div className="mg-guestbook">
      {viewer ? (
        <form onSubmit={submit} className="mg-compose mg-card">
          <label className="mg-compose-label" htmlFor="guestbook-text">
            한마디 남기기
          </label>
          <textarea
            id="guestbook-text"
            value={text}
            disabled={posting}
            maxLength={300}
            rows={2}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
          <div className="mg-compose-foot">
            <label className="mg-check">
              <input type="checkbox" disabled={posting} checked={secret} onChange={(event) => setSecret(event.target.checked)} />
              비밀글
            </label>
            <button className="mg-btn is-primary is-small" type="submit" disabled={posting || !text.trim()}>
              {posting ? '저장 중…' : '남기기'}
            </button>
          </div>
        </form>
      ) : (
        <Link className="mg-btn is-small" to={signIn}>
          로그인
        </Link>
      )}
      {error && (
        <p className="mg-error" role="alert">
          {error}
        </p>
      )}
      <p className="mg-list-count">
        방명록 <b>{total}</b>
      </p>
      {entries.length === 0 && <p className="mg-empty" role="status">{loading ? '불러오는 중…' : '방명록이 없어요'}</p>}
      <ul className="mg-entries">
        {entries.map((entry) => (
          <li key={entry.id}>
            <Link className="mg-avatar" data-tone={toneOf(entry.author.username)} to={`/@${entry.author.username}`} aria-label={`${entry.author.displayName}의 섬`}>
              {initialOf(entry.author.displayName)}
            </Link>
            <div>
              <p className="mg-entry-meta">
                <b>{entry.author.displayName}</b>
                <time dateTime={entry.createdAt}>{when(entry.createdAt)}</time>
                {entry.secret && <span className="mg-badge">비밀글</span>}
                {entry.canDelete && (
                  <button
                    className="mg-link"
                    aria-label={`${entry.author.displayName}의 글 삭제`}
                    disabled={posting}
                    onClick={() =>
                      mutate(async (scope) => {
                        await socialApi.remove(entry.id);
                        if (scope.controller.signal.aborted) return;
                        await load();
                      })
                    }
                  >
                    삭제
                  </button>
                )}
                {owner && entry.author.username !== username && (
                  <button
                    className="mg-link"
                    aria-label={`${entry.author.displayName}의 글 모두 삭제`}
                    disabled={posting}
                    onClick={() => removeAuthor(entry)}
                  >
                    이 사람 글 모두 삭제
                  </button>
                )}
              </p>
              <p className="mg-entry-body">{entry.secret && !entry.body ? '내용 비공개' : entry.body}</p>
            </div>
          </li>
        ))}
      </ul>
      {nextBefore && (
        <button className="mg-btn is-quiet is-wide" disabled={loading || posting} onClick={() => run(() => load(nextBefore))}>
          더 보기
        </button>
      )}
    </div>
  );
}
