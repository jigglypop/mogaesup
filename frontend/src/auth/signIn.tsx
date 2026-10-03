import { Navigate, useLocation } from 'react-router-dom';

/**
 * Where signing in brings the viewer back to: a path on this site taken from `?next=`, or null when there is none or it
 * points elsewhere (another site, `//host`, the sign-in page itself).
 */
export function returnPath(next: string | null | undefined, origin: string = location.origin): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin || url.pathname === '/') return null;
    return `${url.pathname}${url.search}${url.hash}`;
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
