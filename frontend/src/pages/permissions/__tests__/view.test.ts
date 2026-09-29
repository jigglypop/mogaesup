import { describe, expect, it } from 'vitest';

import type { AuditEntry, Trace, UserNames } from '../../../api/permissions';
import { can } from '../../../auth/can';
import {
  ROLES,
  allowedPath,
  auditText,
  grantLabel,
  groupIdProblem,
  groupsOf,
  otherGrants,
  reasonProblem,
  roleState,
  subjectLabel,
  traceText,
} from '../view';

const HOST = '11111111-1111-4111-8111-111111111111';
const users: UserNames = { [HOST]: { username: 'host', displayName: '주인' } };
const role = (name: string) => ROLES.find((item) => item.name === name)!;

describe('권한 화면 문구', () => {
  it('대상과 관계를 사람이 읽는 말로 바꾼다', () => {
    expect(grantLabel('system:mogaesup', 'paid_operator', users)).toBe('유료 작업');
    expect(grantLabel('catalog:mogaesup', 'editor', users)).toBe('카탈로그 편집');
    expect(grantLabel('group:crew', 'member', users)).toBe('그룹 crew 구성원');
    expect(grantLabel(`home:${HOST}`, 'viewer', users)).toBe('@host의 섬 보기');
    expect(subjectLabel('group:crew#member', users)).toBe('그룹 crew 구성원');
    expect(subjectLabel(`user:${HOST}`, users)).toBe('@host');
    expect(subjectLabel('user:22222222-2222-4222-8222-222222222222', users)).toBe('22222222');
  });

  it('기록 한 줄에 누가 무엇을 받고 잃었는지 적는다', () => {
    const entry: AuditEntry = {
      id: 1,
      action: 'revoke',
      object: 'system:mogaesup',
      relation: 'operator',
      subject: `user:${HOST}`,
      actor: 'boss',
      actorId: null,
      reason: '임기 끝',
      createdAt: '2026-09-30T00:00:00Z',
    };
    expect(auditText(entry, users)).toBe('@host의 스튜디오 운영 해제');
    expect(auditText({ ...entry, action: 'grant', subject: 'group:crew#member' }, users)).toBe('그룹 crew 구성원에게 스튜디오 운영 부여');
  });
});

describe('판단 근거', () => {
  const trace: Trace = {
    kind: 'relation',
    object: 'system:mogaesup',
    relation: 'studio_viewer',
    allowed: true,
    children: [
      {
        kind: 'relation',
        object: 'system:mogaesup',
        relation: 'operator',
        allowed: true,
        children: [
          {
            kind: 'direct',
            object: 'system:mogaesup',
            relation: 'operator',
            allowed: true,
            children: [
              { kind: 'userset', object: 'system:mogaesup', relation: 'operator', allowed: false, subject: 'group:old#member' },
              { kind: 'userset', object: 'system:mogaesup', relation: 'operator', allowed: true, subject: 'group:crew#member' },
            ],
          },
        ],
      },
    ],
  };

  it('통과한 길만 위에서 아래로 따라간다', () => {
    expect(allowedPath(trace).map((node) => traceText(node, users))).toEqual([
      '스튜디오 보기',
      '스튜디오 운영',
      '직접 받음',
      '그룹 crew 구성원으로',
    ]);
    expect(allowedPath({ ...trace, allowed: false })).toEqual([]);
  });

  it('사실과 멈춘 이유를 적는다', () => {
    expect(traceText({ kind: 'fact', object: `home:${HOST}`, relation: 'viewer', allowed: true, fact: 'public_home' }, users)).toBe('공개 섬');
    expect(traceText({ kind: 'limit', object: 'group:a', relation: 'member', allowed: false, limit: 'cycle' }, users)).toBe('순환이라 멈춤');
  });
});

describe('사람의 역할', () => {
  const grants = [
    { object: 'system:mogaesup', relation: 'operator' },
    { object: 'group:crew', relation: 'member' },
    { object: `home:${HOST}`, relation: 'viewer' },
  ];
  const permissions = {
    admin: false,
    paid_operator: false,
    operator: true,
    moderator: true,
    catalog_editor: true,
    studio_viewer: true,
  };

  it('직접 받은 것과 다른 역할·그룹으로 받은 것을 가른다', () => {
    expect(roleState(role('operator'), { grants, permissions })).toBe('direct');
    expect(roleState(role('moderator'), { grants, permissions })).toBe('inherited');
    expect(roleState(role('admin'), { grants, permissions })).toBe('none');
    expect(groupsOf(grants)).toEqual(['crew']);
    expect(otherGrants(grants)).toEqual([{ object: `home:${HOST}`, relation: 'viewer' }]);
  });

  it('로그인 정보의 권한으로 화면을 연다', () => {
    const user = { id: HOST, username: 'host', displayName: '주인', role: 'user' as const };
    expect(can({ ...user, permissions: ['catalog_editor', 'studio_viewer'] }, 'catalog_editor')).toBe(true);
    expect(can({ ...user, permissions: ['catalog_editor'] }, 'admin')).toBe(false);
    expect(can({ ...user, role: 'admin' }, 'operator')).toBe(true);
    expect(can(null, 'operator')).toBe(false);
  });

  it('사유와 그룹 이름을 서버와 같은 기준으로 본다', () => {
    expect(reasonProblem('  ')).not.toBeNull();
    expect(reasonProblem('가'.repeat(201))).not.toBeNull();
    expect(reasonProblem('새 운영진')).toBeNull();
    expect(groupIdProblem('crew-2')).toBeNull();
    expect(groupIdProblem('Crew')).not.toBeNull();
    expect(groupIdProblem('a')).not.toBeNull();
  });
});
