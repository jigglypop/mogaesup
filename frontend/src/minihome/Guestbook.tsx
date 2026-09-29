import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Link } from 'react-router-dom';

import { problemText } from '../api/client';
import { socialApi } from '../api/endpoints';
import type { GuestbookEntry, User } from '../api/types';
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
  const [entries, setEntries] = useState<GuestbookEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [secret, setSecret] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (before?: string) => {
      const page = await socialApi.guestbook(username, before);
      setEntries((current) => (before ? [...current, ...page.entries] : page.entries));
      setTotal(page.total);
      setNextBefore(page.nextBefore);
    },
    [username],
  );

  const run = (action: () => Promise<unknown>) => {
    setError('');
    action().catch((problem: unknown) => setError(problemText(problem)));
  };

  useEffect(() => run(() => load()), [load]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;
    run(async () => {
      await socialApi.write(username, { body, secret });
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
            maxLength={300}
            rows={2}
            placeholder="따뜻한 한마디"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
          <div className="mg-compose-foot">
            <label className="mg-check">
              <input type="checkbox" checked={secret} onChange={(event) => setSecret(event.target.checked)} />
              비밀글
            </label>
            <button className="mg-btn is-primary is-small" type="submit" disabled={!text.trim()}>
              남기기
            </button>
          </div>
        </form>
      ) : (
        <p className="mg-compose mg-card mg-muted">
          <Link to="/">로그인</Link>하면 방명록을 남길 수 있어요.
        </p>
      )}
      {error && (
        <p className="mg-error" role="alert">
          {error}
        </p>
      )}
      <p className="mg-list-count">
        방명록 <b>{total}</b>
      </p>
      {entries.length === 0 && <p className="mg-empty">첫 번째로 한마디를 남겨 보세요</p>}
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
                    onClick={() =>
                      run(async () => {
                        await socialApi.remove(entry.id);
                        await load();
                      })
                    }
                  >
                    삭제
                  </button>
                )}
              </p>
              <p className="mg-entry-body">{entry.secret && !entry.body ? '주인과 글쓴이만 볼 수 있어요' : entry.body}</p>
            </div>
          </li>
        ))}
      </ul>
      {nextBefore && (
        <button className="mg-btn is-quiet is-wide" onClick={() => run(() => load(nextBefore))}>
          더 보기
        </button>
      )}
    </div>
  );
}
