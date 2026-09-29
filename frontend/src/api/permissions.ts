import { api } from './client';
import type { PermissionName } from './types';

/**
 * `/api/admin/permissions/*` (`server/src/permissions.rs`). Objects and subjects are written as in the tuples:
 * `system:mogaesup`, `catalog:mogaesup`, `group:crew`, `home:<owner id>`, `user:<id>`, `group:crew#member`. A user may
 * also be named `user:<username>` and a home `home:<username>`. Answers name users by id; `users` maps each id to names.
 */
export type UserNames = Record<string, { username: string; displayName: string }>;

export type Grant = { object: string; relation: string };

export type TupleRow = Grant & { subject: string; createdAt: string; createdBy: string | null };

export type PersonMatch = { id: string; username: string; displayName: string; createdAt: string; grants: Grant[] };

export type Person = {
  user: { id: string; username: string; displayName: string; createdAt: string };
  /** Every tuple naming the person directly. */
  grants: TupleRow[];
  /** Each permission as it stands for them, however it was reached. */
  permissions: Record<PermissionName, boolean>;
  users: UserNames;
};

export type GroupRow = { id: string; members: TupleRow[]; grants: TupleRow[] };

export type Fact = 'home_owner' | 'public_home' | 'ilchon_of_owner';
export type Limit = 'depth' | 'cycle' | 'budget';

/** How a check decided, node by node (see `Trace` in `server/src/rebac.rs`). */
export type Trace = {
  kind: 'relation' | 'direct' | 'userset' | 'fact' | 'limit';
  object: string;
  relation: string;
  allowed: boolean;
  subject?: string;
  fact?: Fact;
  limit?: Limit;
  children?: Trace[];
};

/** Who holds a relation (see `Expansion` in `server/src/rebac.rs`). */
export type Expansion = {
  kind: 'relation' | 'user' | 'userset' | 'fact' | 'limit';
  object: string;
  relation: string;
  subject?: string;
  fact?: Fact;
  limit?: Limit;
  children?: Expansion[];
};

export type AuditEntry = {
  id: number;
  action: 'grant' | 'revoke';
  object: string;
  relation: string;
  subject: string;
  actor: string;
  actorId: string | null;
  reason: string;
  createdAt: string;
};

export type Change = { object: string; relation: string; subject: string; reason: string };

const query = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  return search.toString();
};

export const permissionsApi = {
  /** People by username prefix or name; with no query, everyone holding a grant. */
  search: (q: string) =>
    api<{ matches: PersonMatch[]; users: UserNames }>(`/admin/permissions/users?${query(q.trim() ? { q } : { granted: true })}`),
  person: (username: string) => api<Person>(`/admin/permissions/users/${encodeURIComponent(username)}`),
  groups: () => api<{ groups: GroupRow[]; users: UserNames }>('/admin/permissions/groups'),
  grant: (change: Change) => api<{ changed: boolean }>('/admin/permissions/grant', { method: 'POST', body: change }),
  revoke: (change: Change) => api<{ changed: boolean }>('/admin/permissions/revoke', { method: 'POST', body: change }),
  check: (subject: string, object: string, relation: string) =>
    api<{ allowed: boolean; trace: Trace; users: UserNames }>(`/admin/permissions/check?${query({ subject, object, relation })}`),
  expand: (object: string, relation: string) =>
    api<{ tree: Expansion; holders: string[]; users: UserNames }>(`/admin/permissions/expand?${query({ object, relation })}`),
  audit: (params: { before?: number | undefined; subject?: string | undefined; limit?: number | undefined }) =>
    api<{ entries: AuditEntry[]; nextBefore: number | null; users: UserNames }>(`/admin/permissions/audit?${query(params)}`),
};
