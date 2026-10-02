import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { authApi } from '../api/endpoints';
import type { Credentials, Registration, User } from '../api/types';
import { followSession } from './session';
import { setSessionOwner } from './sessionWork';

type AuthValue = {
  status: 'loading' | 'anonymous' | 'signedIn';
  user: User | null;
  login: (body: Credentials) => Promise<User>;
  register: (body: Registration) => Promise<User>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Asks the server who the session cookie belongs to, then follows sign-in and sign-out. While the server does not
 * answer, nobody is taken for signed out: the screens wait, and it asks again.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const generation = useRef(0);
  const stopChecking = useRef<(() => void) | undefined>(undefined);
  const mounted = useRef(false);
  const changing = useRef(false);

  const accept = (who: User | null) => {
    setSessionOwner(who?.id ?? null);
    setUser(who);
    setReady(true);
  };
  const check = () => {
    const mine = generation.current;
    stopChecking.current = followSession(authApi.me, (who) => {
      if (mounted.current && mine === generation.current) accept(who);
    });
  };

  useEffect(() => {
    mounted.current = true;
    check();
    return () => { mounted.current = false; generation.current++; stopChecking.current?.(); };
  }, []);

  async function change<T>(action: () => Promise<T>, who: (result: T) => User | null): Promise<T> {
    if (changing.current) throw new Error('세션 요청이 진행 중이에요');
    changing.current = true;
    generation.current++;
    stopChecking.current?.();
    try {
      const result = await action();
      if (mounted.current) accept(who(result));
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
      login: async (body) => {
        const result = await change(() => authApi.login(body), (result) => result.user);
        return result.user;
      },
      register: async (body) => {
        const result = await change(() => authApi.register(body), (result) => result.user);
        return result.user;
      },
      logout: async () => {
        await change(authApi.logout, () => null);
      },
    }),
    [ready, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
