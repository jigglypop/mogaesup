import { useEffect, useState } from 'react';

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

  useEffect(() => {
    let live = true;
    permissionsApi.audit({ limit: PAGE }).then(
      (page) => {
        if (!live) return;
        setEntries(page.entries);
        setUsers(page.users);
        setNext(page.nextBefore);
      },
      (reason: unknown) => live && setProblem(problemText(reason)),
    );
    return () => {
      live = false;
    };
  }, [revision]);

  const more = async () => {
    if (next === null) return;
    setLoading(true);
    try {
      const page = await permissionsApi.audit({ limit: PAGE, before: next });
      setEntries((previous) => [...(previous ?? []), ...page.entries]);
      setUsers((previous) => ({ ...previous, ...page.users }));
      setNext(page.nextBefore);
    } catch (reason) {
      setProblem(problemText(reason));
    } finally {
      setLoading(false);
    }
  };

  if (problem && !entries) return <p className="mg-error">{problem}</p>;
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
      {problem && <p className="mg-error">{problem}</p>}
      {next !== null && (
        <button type="button" className="mg-btn is-small" disabled={loading} onClick={() => void more()}>
          더 보기
        </button>
      )}
    </div>
  );
}
