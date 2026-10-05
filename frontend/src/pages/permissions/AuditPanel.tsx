import { useEffect, useRef, useState } from 'react';

import { problemText } from '../../api/client';
import { permissionsApi, type AuditEntry, type UserNames } from '../../api/permissions';
import { auditText, timeText } from './view';

const PAGE = 50;

/** Every grant and revoke, newest first. */
export function AuditPanel({ revision }: { revision: number }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [users, setUsers] = useState<UserNames>({});
  const [next, setNext] = useState<number | null>(null);
  const [problem, setProblem] = useState('');
  const [loading, setLoading] = useState(false);
  /** Counts asks to read the first page again after it failed. */
  const [tries, setTries] = useState(0);
  /** Counts first-page reads: a later page asked for before one belongs to the list it replaced, and is dropped. */
  const generation = useRef(0);

  useEffect(() => {
    let live = true;
    generation.current++;
    setLoading(false);
    permissionsApi.audit({ limit: PAGE }).then(
      (page) => {
        if (!live) return;
        setEntries(page.entries);
        setUsers(page.users);
        setNext(page.nextBefore);
        setProblem('');
      },
      (reason: unknown) => live && setProblem(problemText(reason)),
    );
    return () => {
      live = false;
    };
  }, [revision, tries]);

  const more = async () => {
    if (next === null || loading) return;
    const mine = generation.current;
    setLoading(true);
    setProblem('');
    try {
      const page = await permissionsApi.audit({ limit: PAGE, before: next });
      if (mine !== generation.current) return;
      setEntries((previous) => [...(previous ?? []), ...page.entries]);
      setUsers((previous) => ({ ...previous, ...page.users }));
      setNext(page.nextBefore);
    } catch (reason) {
      if (mine === generation.current) setProblem(problemText(reason));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  };

  if (problem && !entries) {
    return (
      <div className="mg-admin-message is-error" role="alert">
        <span>{problem}</span>
        <button type="button" className="mg-btn is-small" onClick={() => setTries((count) => count + 1)}>
          다시 불러오기
        </button>
      </div>
    );
  }
  if (!entries) return <p className="mg-empty">불러오는 중…</p>;
  if (entries.length === 0) return <p className="mg-empty">기록이 없어요</p>;
  return (
    <div className="mg-perm-log">
      <ul className="mg-perm-audit">
        {entries.map((entry) => (
          <li key={entry.id} className={`is-${entry.action}`}>
            <span className={`mg-badge ${entry.action === 'grant' ? 'is-published' : 'is-retired'}`}>{entry.action === 'grant' ? '부여' : '해제'}</span>
            <b>{auditText(entry, users)}</b>
            <small>
              {timeText(entry.createdAt)} · {entry.actor} · {entry.reason}
            </small>
          </li>
        ))}
      </ul>
      {problem && (
        <p className="mg-error" role="alert">
          {problem}
        </p>
      )}
      {next !== null && (
        <button type="button" className="mg-btn is-small" disabled={loading} onClick={() => void more()}>
          더 보기
        </button>
      )}
    </div>
  );
}
