import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Link } from 'react-router-dom';

import { problemText } from '../api/client';
import { socialApi } from '../api/endpoints';
import type { GuestbookEntry, User } from '../api/types';

const when = (at: string) => {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}시간 전`;
  return new Date(at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
};

/** A Cyworld guestbook sheet over the stage. */
export function Guestbook({
  username,
  viewer,
  onClose,
}: {
  username: string;
  viewer: User | null;
  onClose: () => void;
}) {
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
    <div className="mh-sheet" role="dialog" aria-label="방명록">
      <header>
        <h3>
          방명록 <b>{total}</b>
        </h3>
        <button className="mh-icon-button" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </header>
      {viewer ? (
        <form onSubmit={submit} className="mh-guest-form">
          <span className="mh-friend-face">✏️</span>
          <input
            value={text}
            maxLength={300}
            placeholder="따뜻한 한마디를 남겨 주세요"
            onChange={(event) => setText(event.target.value)}
          />
          <label className="mh-secret">
            <input type="checkbox" checked={secret} onChange={(event) => setSecret(event.target.checked)} />
            비밀글
          </label>
          <button type="submit" disabled={!text.trim()}>
            남기기
          </button>
        </form>
      ) : (
        <p className="mh-muted mh-center">
          <Link to="/">로그인</Link>하면 방명록을 남길 수 있어요.
        </p>
      )}
      {error && (
        <p className="mh-error" role="alert">
          {error}
        </p>
      )}
      <ul className="mh-guest-list">
        {entries.map((entry, index) => (
          <li key={entry.id}>
            <div className="mh-guest-meta">
              <span>No.{total - index}</span>
              <Link to={`/@${entry.author.username}`}>
                <b>{entry.author.displayName}</b>
              </Link>
              <time>{when(entry.createdAt)}</time>
              {entry.secret && <span className="mh-secret-tag">비밀글</span>}
              {entry.canDelete && (
                <button
                  className="mh-link"
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
            </div>
            <div className="mh-guest-body">
              <span className="mh-friend-face">{entry.author.emoji}</span>
              <p>{entry.secret && !entry.body ? '주인과 글쓴이만 볼 수 있어요' : entry.body}</p>
            </div>
          </li>
        ))}
      </ul>
      {nextBefore && (
        <button className="mh-chip-button mh-wide" onClick={() => run(() => load(nextBefore))}>
          더 보기
        </button>
      )}
    </div>
  );
}
