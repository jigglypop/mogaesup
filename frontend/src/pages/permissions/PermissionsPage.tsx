import '../admin/admin.css';
import './permissions.css';

import { useState } from 'react';

import { Navigate } from 'react-router-dom';

import { problemText } from '../../api/client';
import { permissionsApi } from '../../api/permissions';
import { useAuth } from '../../auth/AuthProvider';
import { can } from '../../auth/can';
import { SignInRedirect } from '../../auth/signIn';
import { PageShell } from '../../shell/Shell';
import { Icon } from '../../ui/icons';
import { AdminTabs } from '../AdminTabs';
import { Loading } from '../Loading';
import { AuditPanel } from './AuditPanel';
import { GroupsPanel } from './GroupsPanel';
import { PeoplePanel } from './PeoplePanel';
import { RolesPanel } from './RolesPanel';
import { reasonProblem } from './view';

const SECTIONS = [
  { key: 'people', label: '사람' },
  { key: 'roles', label: '역할' },
  { key: 'groups', label: '그룹' },
  { key: 'audit', label: '기록' },
] as const;
type Section = (typeof SECTIONS)[number]['key'];

type Notice = { tone: 'ok' | 'error'; text: string };

/** A change to make: the tuple, and what to tell once it is made. */
export type Change = { action: 'grant' | 'revoke'; object: string; relation: string; subject: string; done: string };

/** Makes one change with the page's reason; resolves false when it was refused. */
export type Apply = (change: Change) => Promise<boolean>;

/**
 * `/admin/permissions` (admins): who holds which role and why, changes with a reason, groups, and the change log. The
 * server's model is `server/src/rebac.rs`.
 */
export default function PermissionsPage() {
  const { status, user } = useAuth();
  const [section, setSection] = useState<Section>('people');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Counts changes, so every panel reads again after one. */
  const [revision, setRevision] = useState(0);

  if (status === 'loading') return <Loading />;
  if (!user) return <SignInRedirect />;
  if (!can(user, 'admin')) return <Navigate to={can(user, 'catalog_editor') ? '/admin' : `/@${user.username}`} replace />;

  const apply: Apply = async ({ action, done, ...tuple }) => {
    const problem = reasonProblem(reason);
    if (problem) {
      setNotice({ tone: 'error', text: problem });
      return false;
    }
    try {
      const send = action === 'grant' ? permissionsApi.grant : permissionsApi.revoke;
      const result = await send({ ...tuple, reason: reason.trim() });
      setNotice({ tone: 'ok', text: result.changed ? done : '이미 그 상태예요' });
      // A reason belongs to the change it was written for; the next change asks for its own.
      setReason('');
      setRevision((value) => value + 1);
      return true;
    } catch (problem) {
      setNotice({ tone: 'error', text: problemText(problem) });
      return false;
    }
  };
  const changing = section === 'people' || section === 'groups';

  return (
    <PageShell title="운영" wide>
      <section className="mg-glass mg-panel mg-admin mg-perm">
        <div className="mg-panel-head">
          <h1 className="mg-title">운영</h1>
          <AdminTabs />
        </div>
        <div className="mg-perm-bar">
          <div className="mg-tabs is-fit mg-admin-seg" role="group" aria-label="권한">
            {SECTIONS.map((item) => (
              <button key={item.key} type="button" aria-pressed={section === item.key} onClick={() => setSection(item.key)}>
                {item.label}
              </button>
            ))}
          </div>
          {changing && (
            <label className="mg-perm-reason">
              <span>변경 사유</span>
              <input className="mg-field" value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} />
            </label>
          )}
        </div>
        {notice && (
          <div className={`mg-admin-message${notice.tone === 'error' ? ' is-error' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
            <span>{notice.text}</span>
            <button type="button" className="mg-icon-btn is-quiet" aria-label="알림 닫기" onClick={() => setNotice(null)}>
              <Icon name="close" />
            </button>
          </div>
        )}
        {section === 'people' && <PeoplePanel apply={apply} revision={revision} />}
        {section === 'roles' && <RolesPanel revision={revision} />}
        {section === 'groups' && <GroupsPanel apply={apply} revision={revision} />}
        {section === 'audit' && <AuditPanel revision={revision} />}
      </section>
    </PageShell>
  );
}
