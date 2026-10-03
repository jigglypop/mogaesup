import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Link } from 'react-router-dom';

import { problemText } from '../../api/client';
import { permissionsApi, type AuditEntry, type Person, type PersonMatch, type Trace, type UserNames } from '../../api/permissions';
import { Icon } from '../../ui/icons';
import type { Apply } from './PermissionsPage';
import { TraceView } from './TraceView';
import {
  PERMISSIONS,
  ROLES,
  auditText,
  grantLabel,
  groupIdProblem,
  groupsOf,
  otherGrants,
  roleState,
  timeText,
  type Role,
} from './view';

const STATE_LABEL = { direct: '받음', inherited: '포함됨', none: '없음' } as const;
const STATE_BADGE = { direct: 'is-published', inherited: 'is-draft', none: 'is-retired' } as const;

/** People by username or name (everyone holding a grant when the box is empty), and the one chosen. */
export function PeoplePanel({ apply, revision }: { apply: Apply; revision: number }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<PersonMatch[] | null>(null);
  const [names, setNames] = useState<UserNames>({});
  const [problem, setProblem] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  /** Counts asks to search again after a failure. */
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(
      () =>
        permissionsApi.search(query).then(
          (result) => {
            if (!live) return;
            setMatches(result.matches);
            setNames(result.users);
            setProblem('');
          },
          (reason: unknown) => live && setProblem(problemText(reason)),
        ),
      query ? 250 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, revision, tries]);

  return (
    <div className="mg-perm-people">
      <section className="mg-perm-finder" aria-label="사람 찾기">
        <input
          className="mg-field mg-admin-search"
          type="search"
          value={query}
          maxLength={40}
          placeholder="아이디나 이름"
          aria-label="아이디나 이름"
          onChange={(event) => setQuery(event.target.value)}
        />
        {problem && (
          <div className="mg-admin-message is-error" role="alert">
            <span>{problem}</span>
            <button type="button" className="mg-btn is-small" onClick={() => setTries((count) => count + 1)}>
              다시 불러오기
            </button>
          </div>
        )}
        {matches === null ? (
          !problem && <p className="mg-empty">불러오는 중…</p>
        ) : matches.length === 0 ? (
          <p className="mg-empty">{query.trim() ? '맞는 사람이 없어요' : '권한을 받은 사람이 없어요'}</p>
        ) : (
          <ul className="mg-perm-list">
            {matches.map((match) => (
              <li key={match.id}>
                <button type="button" aria-pressed={chosen === match.username} onClick={() => setChosen(match.username)}>
                  <span className="mg-perm-who">
                    <b>{match.displayName}</b>
                    <small>@{match.username}</small>
                  </span>
                  {match.grants.length > 0 && (
                    <span className="mg-admin-chips">
                      {match.grants.map((grant) => (
                        <span key={`${grant.object}#${grant.relation}`} className="mg-badge">
                          {grantLabel(grant.object, grant.relation, names)}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {chosen && <PersonCard key={chosen} username={chosen} apply={apply} revision={revision} onClose={() => setChosen(null)} />}
    </div>
  );
}

function PersonCard({ username, apply, revision, onClose }: { username: string; apply: Apply; revision: number; onClose: () => void }) {
  const [person, setPerson] = useState<Person | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState('');
  const [why, setWhy] = useState<Role | null>(null);
  const card = useRef<HTMLElement>(null);
  const shown = person !== null;

  // One column on narrow screens: the card is below the list, so bring it up once it has loaded.
  useEffect(() => {
    if (shown && window.matchMedia('(max-width: 900px)').matches) card.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [shown]);

  useEffect(() => {
    let live = true;
    permissionsApi.person(username).then(
      (result) => {
        if (!live) return;
        setPerson(result);
        setProblem('');
      },
      (reason: unknown) => live && setProblem(problemText(reason)),
    );
    return () => {
      live = false;
    };
  }, [username, revision]);

  if (!person) {
    return <section className="mg-card mg-perm-person">{problem ? <p className="mg-error">{problem}</p> : <p className="mg-empty">불러오는 중…</p>}</section>;
  }
  const { user } = person;
  const subject = `user:${user.id}`;
  const run = async (change: Parameters<Apply>[0]) => {
    setBusy(true);
    const ok = await apply(change);
    setBusy(false);
    return ok;
  };
  const toggle = (role: Role, direct: boolean) => {
    if (role.name === 'admin') {
      const ask = direct ? `${user.displayName}(@${user.username})의 관리자 권한을 해제할까요?` : `${user.displayName}(@${user.username})에게 관리자 권한을 줄까요?`;
      if (!window.confirm(ask)) return;
    }
    const action = direct ? 'revoke' : 'grant';
    void run({ action, object: role.object, relation: role.relation, subject, done: `@${user.username}: ${role.label} ${direct ? '해제' : '부여'}` });
  };
  const addGroup = async (event: FormEvent) => {
    event.preventDefault();
    const id = group.trim();
    const invalid = groupIdProblem(id);
    if (invalid) return setProblem(invalid);
    setProblem('');
    if (await run({ action: 'grant', object: `group:${id}`, relation: 'member', subject, done: `@${user.username}: 그룹 ${id}에 넣음` })) setGroup('');
  };
  const groups = groupsOf(person.grants);
  const others = otherGrants(person.grants);

  return (
    <section ref={card} className="mg-card mg-perm-person" aria-label={`@${user.username} 권한`}>
      <header className="mg-perm-person-head">
        <span className="mg-perm-who">
          <b>{user.displayName}</b>
          <small>@{user.username}</small>
        </span>
        <Link className="mg-btn is-small is-quiet" to={`/@${user.username}`}>
          섬
        </Link>
        <button type="button" className="mg-icon-btn is-quiet" aria-label="닫기" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      <h3 className="mg-heading">역할</h3>
      <ul className="mg-perm-roles">
        {ROLES.map((role) => {
          const state = roleState(role, person);
          return (
            <li key={role.name}>
              <span className="mg-perm-role">
                <b>{role.label}</b>
                <small>{role.note}</small>
              </span>
              <span className={`mg-badge ${STATE_BADGE[state]}`}>{STATE_LABEL[state]}</span>
              <span className="mg-admin-actions">
                {state === 'inherited' && (
                  <button type="button" className="mg-btn is-small is-quiet" onClick={() => setWhy(role)}>
                    근거
                  </button>
                )}
                <button
                  type="button"
                  className={`mg-btn is-small${state === 'direct' ? ' is-danger' : ''}`}
                  disabled={busy}
                  onClick={() => toggle(role, state === 'direct')}
                >
                  {state === 'direct' ? '해제' : '부여'}
                </button>
              </span>
            </li>
          );
        })}
      </ul>

      <h3 className="mg-heading">그룹</h3>
      {groups.length > 0 && (
        <div className="mg-admin-chips">
          {groups.map((id) => (
            <span key={id} className="mg-perm-tag">
              {id}
              <button
                type="button"
                aria-label={`그룹 ${id}에서 빼기`}
                disabled={busy}
                onClick={() => void run({ action: 'revoke', object: `group:${id}`, relation: 'member', subject, done: `@${user.username}: 그룹 ${id}에서 뺌` })}
              >
                <Icon name="close" />
              </button>
            </span>
          ))}
        </div>
      )}
      <form className="mg-perm-inline" onSubmit={(event) => void addGroup(event)}>
        <input className="mg-field" value={group} maxLength={32} placeholder="그룹 이름" aria-label="넣을 그룹" onChange={(event) => setGroup(event.target.value)} />
        <button type="submit" className="mg-btn is-small" disabled={busy || !group.trim()}>
          그룹에 넣기
        </button>
      </form>
      {problem && <p className="mg-error">{problem}</p>}

      {others.length > 0 && (
        <>
          <h3 className="mg-heading">그 밖의 권한</h3>
          <ul className="mg-perm-rows">
            {others.map((grant) => (
              <li key={`${grant.object}#${grant.relation}`}>
                <span>{grantLabel(grant.object, grant.relation, person.users)}</span>
                <button
                  type="button"
                  className="mg-btn is-small is-danger"
                  disabled={busy}
                  onClick={() =>
                    void run({
                      action: 'revoke',
                      object: grant.object,
                      relation: grant.relation,
                      subject,
                      done: `@${user.username}: ${grantLabel(grant.object, grant.relation, person.users)} 해제`,
                    })
                  }
                >
                  해제
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="mg-heading">판단 근거</h3>
      <div className="mg-tabs is-fit mg-admin-seg" role="group" aria-label="확인할 권한">
        {PERMISSIONS.map((permission) => (
          <button key={permission.name} type="button" aria-pressed={why?.name === permission.name} onClick={() => setWhy(permission)}>
            {permission.label}
          </button>
        ))}
      </div>
      {why && <Explain subject={subject} role={why} revision={revision} />}

      <PersonLog subject={subject} revision={revision} />
    </section>
  );
}

function Explain({ subject, role, revision }: { subject: string; role: Role; revision: number }) {
  const [result, setResult] = useState<{ trace: Trace; users: UserNames } | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true;
    setResult(null);
    permissionsApi.check(subject, role.object, role.relation).then(
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
  }, [subject, role, revision]);
  if (problem) return <p className="mg-error">{problem}</p>;
  return result ? <TraceView trace={result.trace} users={result.users} /> : null;
}

/** The latest changes to what this person holds. */
function PersonLog({ subject, revision }: { subject: string; revision: number }) {
  const [log, setLog] = useState<{ entries: AuditEntry[]; users: UserNames } | null>(null);
  useEffect(() => {
    let live = true;
    permissionsApi.audit({ subject, limit: 10 }).then(
      (found) => live && setLog(found),
      () => live && setLog(null),
    );
    return () => {
      live = false;
    };
  }, [subject, revision]);
  if (!log || log.entries.length === 0) return null;
  return (
    <>
      <h3 className="mg-heading">최근 변경</h3>
      <ul className="mg-perm-audit">
        {log.entries.map((entry) => (
          <li key={entry.id}>
            <b>{auditText(entry, log.users)}</b>
            <small>
              {timeText(entry.createdAt)} · {entry.actor} · {entry.reason}
            </small>
          </li>
        ))}
      </ul>
    </>
  );
}
