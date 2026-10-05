import { Navigate, useLocation } from 'react-router-dom';

/** A path on this site: one slash, and then neither a second one nor a backslash (which browsers read as `//host`). */
const SITE_PATH = /^\/(?![/\\])/;

/**
 * Where signing in brings the viewer back to: a path on this site taken from `?next=`, or null when there is none or it
 * points elsewhere (another site, `//host`, the sign-in page itself). The path is checked again once normalized, since
 * dot segments and backslashes can turn one into `//host` (`/.//host`, `/%2e//host`, `/x/..//host`, `/./\host`).
 */
export function returnPath(next: string | null | undefined, origin: string = location.origin): string | null {
  if (!next || !SITE_PATH.test(next)) return null;
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin || url.pathname === '/') return null;
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (!SITE_PATH.test(path) || new URL(path, origin).origin !== origin) return null;
    return path;
  } catch {
    return null;
  }
}

/** The sign-in page, coming back to `here` (a path with its query) afterwards. */
export const signInPath = (here: string) => (returnPath(here) ? `/?next=${encodeURIComponent(here)}` : '/');

/** The sign-in page's address from the screen the viewer is on now. */
export function useSignInPath(): string {
  const { pathname, search, hash } = useLocation();
  return signInPath(`${pathname}${search}${hash}`);
}

/** For a screen that needs a signed-in viewer: off to sign in, and back here after. */
export function SignInRedirect() {
  return <Navigate to={useSignInPath()} replace />;
}
