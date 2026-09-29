import type { PermissionName, User } from '../api/types';

/** Whether `user` holds `permission`, as the server told at sign-in (`/auth/me`). */
export function can(user: User | null | undefined, permission: PermissionName): boolean {
  if (!user) return false;
  return user.permissions ? user.permissions.includes(permission) : user.role === 'admin';
}
