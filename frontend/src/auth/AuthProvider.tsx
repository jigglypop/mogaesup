import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { authApi } from '../api/endpoints';
import type { Credentials, Registration, User } from '../api/types';

type AuthValue = {
  status: 'loading' | 'anonymous' | 'signedIn';
  user: User | null;
  login: (body: Credentials) => Promise<User>;
  register: (body: Registration) => Promise<User>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

/** Asks the server who the session cookie belongs to once, then follows sign-in and sign-out. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    authApi
      .me()
      .then((result) => setUser(result.user), () => setUser(null))
      .finally(() => setReady(true));
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status: !ready ? 'loading' : user ? 'signedIn' : 'anonymous',
      user,
      login: async (body) => {
        const result = await authApi.login(body);
        setUser(result.user);
        return result.user;
      },
      register: async (body) => {
        const result = await authApi.register(body);
        setUser(result.user);
        return result.user;
      },
      logout: async () => {
        await authApi.logout().catch(() => undefined);
        setUser(null);
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
