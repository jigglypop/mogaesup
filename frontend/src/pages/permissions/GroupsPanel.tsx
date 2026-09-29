import { useEffect, useState, type FormEvent } from 'react';

import { problemText } from '../../api/client';
import { permissionsApi, type GroupRow, type UserNames } from '../../api/permissions';
import { Icon } from '../../ui/icons';
import type { Apply } from './PermissionsPage';
import { ROLES, grantLabel, groupIdProblem, subjectLabel } from './view';

const GROUP_ROLES = ROLES.filter((role) => role.groups);

/** A member typed in: `group:<id>` for a group inside the group, else a username. */
const memberSubject = (text: string) => (text.startsWith('group:') ? `${text}#member` : `user:${text}`);

/** Every group, its members and the roles its members hold through it; a group starts with its first member. */
export function GroupsPanel({ apply, revision }: { apply: Apply; revision: number }) {
  const [groups, setGroups] = useState<GroupRow[] | null>(null);
  const [users, setUsers] = useState<UserNames>({});
  const [problem, setProblem] = useState('');
  const [name, setName] = useState('');
  const [first, setFirst] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    permissionsApi.groups().then(
      (result) => {
        if (!live) return;
        setGroups(result.groups);
        setUsers(result.users);
      },
      (reason: unknown) => live && setProblem(problemText(reason)),
    );
    return () => {
      live = false;
    };
  }, [revision]);

  const run = async (change: Parameters<Apply>[0]) => {
    setBusy(true);
    const ok = await apply(change);
    setBusy(false);
    return ok;
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const id = name.trim();
    const member = first.trim().toLowerCase();
    const invalid = groupIdProblem(id);
    if (invalid) return setProblem(invalid);
    setProblem('');
    if (await run({ action: 'grant', object: `group:${id}`, relation: 'member', subject: memberSubject(member), done: `그룹 ${id}을 만들었어요` })) {
      setName('');
      setFirst('');
    }
  };

  return (
    <div className="mg-perm-groups">
      <form className="mg-perm-inline mg-card" onSubmit={(event) => void create(event)} aria-label="새 그룹">
        <input className="mg-field" value={name} maxLength={32} placeholder="새 그룹 이름" aria-label="새 그룹 이름" onChange={(event) => setName(event.target.value)} />
        <input className="mg-field" value={first} maxLength={40} placeholder="첫 구성원 아이디" aria-label="첫 구성원 아이디" onChange={(event) => setFirst(event.target.value)} />
        <button type="submit" className="mg-btn is-small is-primary" disabled={busy || !name.trim() || !first.trim()}>
          <Icon name="plus" /> 만들기
        </button>
      </form>
      {problem && <p className="mg-error">{problem}</p>}
      {groups === null ? (
        !problem && <p className="mg-empty">불러오는 중…</p>
      ) : groups.length === 0 ? (
        <p className="mg-empty">그룹이 없어요</p>
      ) : (
        <ul className="mg-perm-group-list">
          {groups.map((group) => (
            <GroupCard key={group.id} group={group} users={users} busy={busy} run={run} />
          ))}
        </ul>
      )}
    </div>
  );
}

function GroupCard({
  group,
  users,
  busy,
  run,
}: {
  group: GroupRow;
  users: UserNames;
  busy: boolean;
  run: (change: Parameters<Apply>[0]) => Promise<boolean>;
}) {
  const [member, setMember] = useState('');
  const [role, setRole] = useState(GROUP_ROLES[0]?.name ?? 'operator');
  const object = `group:${group.id}`;
  const members = `${object}#member`;

  const addMember = async (event: FormEvent) => {
    event.preventDefault();
    const text = member.trim().toLowerCase();
    if (await run({ action: 'grant', object, relation: 'member', subject: memberSubject(text), done: `그룹 ${group.id}: ${text} 넣음` })) setMember('');
  };
  const give = (event: FormEvent) => {
    event.preventDefault();
    const chosen = GROUP_ROLES.find((item) => item.name === role);
    if (chosen) void run({ action: 'grant', object: chosen.object, relation: chosen.relation, subject: members, done: `그룹 ${group.id}: ${chosen.label} 부여` });
  };

  return (
    <li className="mg-card mg-perm-group">
      <header>
        <b>그룹 {group.id}</b>
        <small>구성원 {group.members.length}</small>
      </header>
      <div className="mg-admin-chips" aria-label="구성원">
        {group.members.map((tuple) => (
          <span key={tuple.subject} className="mg-perm-tag">
            {subjectLabel(tuple.subject, users)}
            <button
              type="button"
              aria-label={`${subjectLabel(tuple.subject, users)} 빼기`}
              disabled={busy}
              onClick={() => void run({ action: 'revoke', object, relation: 'member', subject: tuple.subject, done: `그룹 ${group.id}: ${subjectLabel(tuple.subject, users)} 뺌` })}
            >
              <Icon name="close" />
            </button>
          </span>
        ))}
      </div>
      <form className="mg-perm-inline" onSubmit={(event) => void addMember(event)}>
        <input className="mg-field" value={member} maxLength={40} placeholder="아이디 또는 group:이름" aria-label={`그룹 ${group.id}에 넣을 사람`} onChange={(event) => setMember(event.target.value)} />
        <button type="submit" className="mg-btn is-small" disabled={busy || !member.trim()}>
          넣기
        </button>
      </form>
      <div className="mg-admin-chips" aria-label="그룹이 받은 역할">
        {group.grants.map((tuple) => (
          <span key={`${tuple.object}#${tuple.relation}`} className="mg-perm-tag is-role">
            {grantLabel(tuple.object, tuple.relation, users)}
            <button
              type="button"
              aria-label={`${grantLabel(tuple.object, tuple.relation, users)} 해제`}
              disabled={busy}
              onClick={() => void run({ action: 'revoke', object: tuple.object, relation: tuple.relation, subject: members, done: `그룹 ${group.id}: ${grantLabel(tuple.object, tuple.relation, users)} 해제` })}
            >
              <Icon name="close" />
            </button>
          </span>
        ))}
      </div>
      <form className="mg-perm-inline" onSubmit={give}>
        <select className="mg-field mg-admin-select" value={role} aria-label={`그룹 ${group.id}에 줄 역할`} onChange={(event) => setRole(event.target.value as typeof role)}>
          {GROUP_ROLES.map((item) => (
            <option key={item.name} value={item.name}>
              {item.label}
            </option>
          ))}
        </select>
        <button type="submit" className="mg-btn is-small" disabled={busy}>
          역할 주기
        </button>
      </form>
    </li>
  );
}
