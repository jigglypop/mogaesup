import { useEffect, useState } from 'react';

import { problemText } from '../../api/client';
import { permissionsApi, type Expansion, type UserNames } from '../../api/permissions';
import { ExpansionView } from './TraceView';
import { PERMISSIONS, type Role } from './view';

/** Everyone who holds a permission, however they came to, and the rules and grants behind it. */
export function RolesPanel({ revision }: { revision: number }) {
  const [role, setRole] = useState<Role>(PERMISSIONS[0]!);
  const [result, setResult] = useState<{ tree: Expansion; holders: string[]; users: UserNames } | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let live = true;
    setResult(null);
    permissionsApi.expand(role.object, role.relation).then(
      (found) => {
        if (!live) return;
        setResult(found);
        setProblem('');
      },
      (reason: unknown) => live && setProblem(problemText(reason)),
    );
    return () => {
      live = false;
    };
  }, [role, revision]);

  return (
    <div className="mg-perm-roles-view">
      <div className="mg-tabs is-fit mg-admin-seg" role="group" aria-label="권한">
        {PERMISSIONS.map((item) => (
          <button key={item.name} type="button" aria-pressed={role.name === item.name} onClick={() => setRole(item)}>
            {item.label}
          </button>
        ))}
      </div>
      <p className="mg-muted mg-perm-note">{role.note}</p>
      {problem && <p className="mg-error">{problem}</p>}
      {result && (
        <>
          <p className="mg-perm-count">
            <b>{result.holders.length}</b>명
          </p>
          {result.holders.length > 0 && (
            <ul className="mg-perm-holders">
              {result.holders.map((id) => {
                const found = result.users[id];
                return (
                  <li key={id} className="mg-perm-who">
                    <b>{found?.displayName ?? id.slice(0, 8)}</b>
                    {found && <small>@{found.username}</small>}
                  </li>
                );
              })}
            </ul>
          )}
          <details>
            <summary>구성</summary>
            <ExpansionView tree={result.tree} users={result.users} />
          </details>
        </>
      )}
    </div>
  );
}
