import type { AuditEntry, Expansion, Fact, Grant, Limit, Person, Trace, UserNames } from '../../api/permissions';
import type { PermissionName } from '../../api/types';

export const SYSTEM = 'system:mogaesup';
export const CATALOG = 'catalog:mogaesup';

/** A permission as the object and relation that hold it. `groups`: whether a group may be given it. */
export type Role = { name: PermissionName; object: string; relation: string; label: string; note: string; groups: boolean };

/** What an admin gives people and groups, strongest first. */
export const ROLES: readonly Role[] = [
  { name: 'admin', object: SYSTEM, relation: 'admin', label: '관리자', note: '모든 권한, 권한 관리', groups: false },
  { name: 'paid_operator', object: SYSTEM, relation: 'paid_operator', label: '유료 작업', note: '비용이 드는 스튜디오 작업', groups: true },
  { name: 'operator', object: SYSTEM, relation: 'operator', label: '스튜디오 운영', note: '스튜디오 기록 바꾸기', groups: true },
  { name: 'moderator', object: SYSTEM, relation: 'moderator', label: '모더레이터', note: '방명록 글 지우기, 카탈로그', groups: true },
  { name: 'catalog_editor', object: CATALOG, relation: 'editor', label: '카탈로그 편집', note: '가져오기, 공개, 되돌리기', groups: true },
];

/** Every permission the server checks: the roles, and what they add up to. */
export const PERMISSIONS: readonly Role[] = [
  ...ROLES,
  { name: 'studio_viewer', object: SYSTEM, relation: 'studio_viewer', label: '스튜디오 보기', note: '스튜디오 화면·모델·전원', groups: false },
];

const RELATIONS: Record<string, string> = {
  'group#member': '구성원',
  'home#owner': '주인',
  'home#editor': '편집',
  'home#viewer': '보기',
};

const FACTS: Record<Fact, string> = {
  home_owner: '섬 주인',
  public_home: '공개 섬',
  ilchon_of_owner: '일촌 공개 섬의 일촌',
};

const LIMITS: Record<Limit, string> = {
  depth: '깊이 제한에서 멈춤',
  cycle: '순환이라 멈춤',
  budget: '조회 한도에서 멈춤',
};

/** `system`, `group`… of `system:mogaesup`, `group:crew#member`. */
export const typeOf = (ref: string) => ref.slice(0, Math.max(0, ref.indexOf(':')));

/** `mogaesup`, `crew`… of `system:mogaesup`, `group:crew#member`. */
export const idOf = (ref: string) => ref.slice(ref.indexOf(':') + 1).split('#')[0] ?? '';

/** `@username` for a user id, or the id's start when the server sent no name for it. */
export const nameOf = (id: string, users: UserNames) => {
  const found = users[id];
  return found ? `@${found.username}` : id.slice(0, 8);
};

export function objectLabel(ref: string, users: UserNames): string {
  const id = idOf(ref);
  switch (typeOf(ref)) {
    case 'system':
      return '모개숲';
    case 'catalog':
      return '카탈로그';
    case 'group':
      return `그룹 ${id}`;
    case 'home':
      return `${nameOf(id, users)}의 섬`;
    case 'user':
      return nameOf(id, users);
    default:
      return ref;
  }
}

export function relationLabel(object: string, relation: string): string {
  const role = PERMISSIONS.find((item) => item.object === object && item.relation === relation);
  return role?.label ?? RELATIONS[`${typeOf(object)}#${relation}`] ?? relation;
}

/** A grant in a few words: `관리자`, `그룹 crew 구성원`, `@host의 섬 보기`. */
export function grantLabel(object: string, relation: string, users: UserNames): string {
  const type = typeOf(object);
  if (type === 'system' || type === 'catalog') return relationLabel(object, relation);
  return `${objectLabel(object, users)} ${relationLabel(object, relation)}`;
}

/** Who a tuple names: `@username`, or `그룹 crew 구성원`. */
export function subjectLabel(subject: string, users: UserNames): string {
  if (subject === 'anonymous') return '로그인하지 않은 방문자';
  if (typeOf(subject) === 'group') return `그룹 ${idOf(subject)} 구성원`;
  return objectLabel(subject, users);
}

/** One node of an explanation. */
export function traceText(node: Trace, users: UserNames): string {
  switch (node.kind) {
    case 'relation':
      return grantLabel(node.object, node.relation, users);
    case 'direct':
      return node.allowed ? '직접 받음' : '직접 받은 것 없음';
    case 'userset':
      return `${subjectLabel(node.subject ?? '', users)}으로`;
    case 'fact':
      return node.fact ? FACTS[node.fact] : '';
    case 'limit':
      return node.limit ? LIMITS[node.limit] : '';
  }
}

/** The nodes a passing check went through, from the permission asked down to what granted it. */
export function allowedPath(trace: Trace): Trace[] {
  const path: Trace[] = [];
  let node: Trace | undefined = trace;
  while (node?.allowed) {
    path.push(node);
    node = node.children?.find((child) => child.allowed);
  }
  return path;
}

/** One node of who holds a relation. */
export function expansionText(node: Expansion, users: UserNames): string {
  switch (node.kind) {
    case 'relation':
      return grantLabel(node.object, node.relation, users);
    case 'user':
    case 'userset':
      return subjectLabel(node.subject ?? '', users);
    case 'fact':
      return node.fact === 'public_home' ? '모든 방문자(공개 섬)' : '주인의 일촌';
    case 'limit':
      return node.limit ? LIMITS[node.limit] : '';
  }
}

/** Whether a person has a role through their own grant, through something else (a stronger role, a group), or not. */
export function roleState(
  role: Role,
  person: { grants: readonly Grant[]; permissions: Person['permissions'] },
): 'direct' | 'inherited' | 'none' {
  if (person.grants.some((grant) => grant.object === role.object && grant.relation === role.relation)) return 'direct';
  return person.permissions[role.name] ? 'inherited' : 'none';
}

/** The groups a person was put in directly. */
export const groupsOf = (grants: readonly Grant[]) =>
  grants.filter((grant) => typeOf(grant.object) === 'group' && grant.relation === 'member').map((grant) => idOf(grant.object));

/** Grants other than the roles and groups: homes shared with them. */
export const otherGrants = <T extends Grant>(grants: readonly T[]) =>
  grants.filter(
    (grant) =>
      !ROLES.some((role) => role.object === grant.object && role.relation === grant.relation) &&
      !(typeOf(grant.object) === 'group' && grant.relation === 'member'),
  );

/** `관리자` → `@boss`, the change's direction and what it was about. */
export function auditText(entry: AuditEntry, users: UserNames): string {
  const what = grantLabel(entry.object, entry.relation, users);
  const who = subjectLabel(entry.subject, users);
  return entry.action === 'grant' ? `${who}에게 ${what} 부여` : `${who}의 ${what} 해제`;
}

export function reasonProblem(reason: string): string | null {
  const text = reason.trim();
  if (!text) return '변경 사유를 적어 주세요';
  if ([...text].length > 200) return '사유는 200자 이하로 적어 주세요';
  return null;
}

/** A group id the server takes: 2–32 lowercase letters, digits, `_` or `-`. */
export function groupIdProblem(id: string): string | null {
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(id) ? null : '그룹 이름은 영문 소문자·숫자·밑줄·하이픈 2~32자예요';
}

export const timeText = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', { year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
