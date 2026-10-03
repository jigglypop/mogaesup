import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { authApi } from '../api/endpoints';
import type { Credentials, Registration, User } from '../api/types';
import { clearDrafts } from './drafts';
import { followSession, SESSION_RETRY_MS, SESSION_UNREACHABLE_AFTER } from './session';
import { onSessionLapse, sessionLapsed, setSessionOwner } from './sessionWork';

type AuthValue = {
  status: 'loading' | 'anonymous' | 'signedIn';
  user: User | null;
  /** The member whose session ran out while they were signed in here, until anyone signs in or out. */
  lapsed: User | null;
  /** The server has not said who is signed in after several tries; the screens wait and offer `retry`. */
  unreachable: boolean;
  /** Asks the server again now. */
  retry: () => void;
  login: (body: Credentials) => Promise<User>;
  register: (body: Registration) => Promise<User>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Asks the server who the session cookie belongs to, then follows sign-in and sign-out. While the server does not
 * answer, nobody is taken for signed out: the screens wait, and it asks again. A session the server stops taking (a 401
 * on any request) signs the member out but keeps their unsaved work: signing in again as them resumes it.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [lapsed, setLapsed] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [failures, setFailures] = useState(0);
  const generation = useRef(0);
  const stopChecking = useRef<(() => void) | undefined>(undefined);
  const mounted = useRef(false);
  const changing = useRef(false);
  /** Whom the session belongs to: the signed-in member, or the one whose session lapsed. */
  const owner = useRef<User | null>(null);

  const accept = (who: User | null, signedOut = false) => {
    setReady(true);
    setFailures(0);
    // A lapsed session reads as nobody signed in; that alone ends nothing the member left unsaved.
    if (!who && !signedOut && sessionLapsed()) return;
    if (owner.current && owner.current.id !== who?.id) clearDrafts();
    owner.current = who;
    setSessionOwner(who?.id ?? null);
    setUser(who);
    setLapsed(null);
  };
  const check = () => {
    const mine = generation.current;
    const current = () => mounted.current && mine === generation.current;
    stopChecking.current = followSession(
      authApi.me,
      (who) => {
        if (current()) accept(who);
      },
      SESSION_RETRY_MS,
      (count) => {
        if (current()) setFailures(count);
      },
    );
  };
  const askAgain = () => {
    generation.current++;
    stopChecking.current?.();
    check();
  };

  useEffect(() => {
    mounted.current = true;
    check();
    const stopLapse = onSessionLapse(() => {
      if (!mounted.current) return;
      setLapsed(owner.current);
      setUser(null);
    });
    return () => { mounted.current = false; generation.current++; stopChecking.current?.(); stopLapse(); };
  }, []);

  // Signed in again in another tab: coming back to this one finds out.
  useEffect(() => {
    if (!lapsed) return undefined;
    const back = () => {
      if (document.visibilityState === 'visible') askAgain();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [lapsed]);

  async function change<T>(action: () => Promise<T>, who: (result: T) => User | null, signedOut = false): Promise<T> {
    if (changing.current) throw new Error('세션 요청이 진행 중이에요');
    changing.current = true;
    generation.current++;
    stopChecking.current?.();
    try {
      const result = await action();
      if (mounted.current) accept(who(result), signedOut);
      return result;
    } catch (error) {
      if (!ready && mounted.current) check();
      throw error;
    } finally { changing.current = false; }
  }

  const value = useMemo<AuthValue>(
    () => ({
      status: !ready ? 'loading' : user ? 'signedIn' : 'anonymous',
      user,
      lapsed,
      unreachable: !ready && failures >= SESSION_UNREACHABLE_AFTER,
      retry: () => {
        setFailures(0);
        askAgain();
      },
      login: async (body) => {
        const result = await change(() => authApi.login(body), (result) => result.user);
        return result.user;
      },
      register: async (body) => {
        const result = await change(() => authApi.register(body), (result) => result.user);
        return result.user;
      },
      logout: async () => {
        await change(authApi.logout, () => null, true);
      },
    }),
    [ready, user, lapsed, failures],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/** The same, for pieces that may also show outside the provider (the loading screen). */
export const useOptionalAuth = (): AuthValue | null => useContext(AuthContext);
