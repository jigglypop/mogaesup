import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { authApi } from '../api/endpoints';
import type { Credentials, Registration, User } from '../api/types';
import { clearDrafts } from './drafts';
import { openSessionChannel, type SessionChannel } from './otherTabs';
import { followSession, SESSION_RETRY_MS, SESSION_UNREACHABLE_AFTER } from './session';
import {
  expireSession,
  hasUnsavedWork,
  onSessionCheck,
  onSessionLapse,
  onSessionRenewed,
  renewedElsewhere,
  sessionEpoch,
  sessionLapsed,
  setSessionOwner,
} from './sessionWork';

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
 * A page left open asks who is signed in again once it is in view this long after it last asked. The server renews a
 * session it is asked about that way (as each opening of the app does), so a tab kept open for weeks stays signed in.
 */
export const SESSION_RENEW_MS = 12 * 60 * 60 * 1000;

const sameMember = (a: User, b: User) =>
  a.id === b.id && a.username === b.username && a.displayName === b.displayName && a.role === b.role
  && (a.permissions ?? []).join() === (b.permissions ?? []).join();

/**
 * Asks the server who the session cookie belongs to, then follows sign-in and sign-out. While the server does not
 * answer, nobody is taken for signed out: the screens wait, and it asks again. A session the server stops taking (a 401
 * on any request) signs the member out but keeps their unsaved work: signing in again as them resumes it.
 *
 * The cookie is the whole site's, so another tab signing out, or in as someone else, changes who this one acts as. This
 * tab asks again when it is shown, when another tab says it signed in or out (or started the session over), and when a
 * request answers for someone else (`requestSessionCheck`), and follows the answer; a password change or signing out
 * the other devices here tells the other tabs too, so they take the new cookie for the same member.
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
  /** The server has said who is signed in at least once. */
  const answered = useRef(false);
  /** An ask is on its way (or waiting to be sent again). */
  const asking = useRef(false);
  /** When who is signed in was last asked. */
  const askedAt = useRef(0);
  /** Another tab changed the session while this one signed in or out: ask once that is done. */
  const heardMeanwhile = useRef(false);
  const channel = useRef<SessionChannel | null>(null);

  const accept = (who: User | null, signedOut = false) => {
    answered.current = true;
    setReady(true);
    setFailures(0);
    // A lapsed session reads as nobody signed in; that alone ends nothing the member left unsaved.
    if (!who && !signedOut && sessionLapsed()) return;
    // Signing in leaves only this member's drafts in the browser, whoever was here before (a page reloaded after a lapse
    // knows nobody); signing out, or another tab's sign-out, leaves none.
    if (who) clearDrafts(who.id);
    else if (signedOut || owner.current) clearDrafts();
    owner.current = who;
    setSessionOwner(who?.id ?? null);
    setUser(who);
    setLapsed(null);
  };
  /**
   * The answer to asking again once this tab knew who was signed in (asked at `sentAt`). The same member changes nothing
   * (but what the server now says about them). Nobody means their session ended elsewhere (another tab signed out): that
   * is taken as a lapse, so what they left unsaved here waits for them; unless the session started over since the
   * question went out, when the answer speaks of the old cookie. Someone else is followed as a sign-in here would be,
   * but not over edits the member left unsaved here: a sign-in made in another tab does not drop them, so this tab
   * lapses instead, and signing in here decides (as the member, it carries on; as anyone else, the sign-in page asks).
   */
  const follow = (who: User | null, sentAt: number) => {
    const known = owner.current;
    if (known && who && who.id !== known.id && hasUnsavedWork()) {
      setReady(true);
      setFailures(0);
      expireSession();
      return;
    }
    if (!known || sessionLapsed() || (who && who.id !== known.id)) {
      accept(who);
      return;
    }
    setReady(true);
    setFailures(0);
    if (!who) {
      expireSession(sentAt);
      return;
    }
    owner.current = who;
    if (!sameMember(who, known)) setUser(who);
  };
  const check = () => {
    const mine = generation.current;
    const current = () => mounted.current && mine === generation.current;
    let sentAt = sessionEpoch();
    asking.current = true;
    askedAt.current = Date.now();
    stopChecking.current = followSession(
      () => {
        sentAt = sessionEpoch();
        return authApi.me();
      },
      (who) => {
        if (!current()) return;
        asking.current = false;
        if (answered.current) follow(who, sentAt);
        else accept(who);
      },
      SESSION_RETRY_MS,
      (count) => {
        if (current() && !answered.current) setFailures(count);
      },
    );
  };
  /** Drops the ask on its way: its answer would speak for the session before whatever comes next. */
  const stopAsking = () => {
    generation.current++;
    stopChecking.current?.();
    asking.current = false;
  };
  /** Asks again now; `whenIdle` leaves it to an ask already on its way (focus and visibility arrive together). */
  const askAgain = (whenIdle = false) => {
    // A sign-in or sign-out on its way decides who is signed in; an answer to a question asked meanwhile would undo it.
    if (changing.current || (whenIdle && asking.current)) return;
    stopAsking();
    check();
  };
  /**
   * Another tab signed in, out or started the session over, or a request answered for someone else: asks again, now or,
   * while this tab signs in or out itself, once that is done (which of the two the cookie ended with is the server's
   * to say).
   */
  const heard = () => {
    if (changing.current) heardMeanwhile.current = true;
    else askAgain();
  };

  useEffect(() => {
    mounted.current = true;
    check();
    const stopLapse = onSessionLapse(() => {
      if (!mounted.current) return;
      setLapsed(owner.current);
      setUser(null);
    });
    const stopCheck = onSessionCheck(heard);
    const tabs = openSessionChannel((news) => {
      // The other tab's answer brought the browser a new cookie: refusals of the old one are no longer news.
      if (news.renewed) renewedElsewhere();
      heard();
    });
    channel.current = tabs;
    const stopRenewed = onSessionRenewed(() => tabs.announce(owner.current?.id ?? null, true));
    return () => {
      mounted.current = false;
      stopAsking();
      stopLapse();
      stopCheck();
      stopRenewed();
      tabs.close();
      channel.current = null;
    };
  }, []);

  // Coming back to this tab: another one may have signed out, or in as someone else (or again as the member whose
  // session lapsed here), meanwhile.
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === 'visible' && answered.current) askAgain(true);
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);

  // A page left in view, never hidden or left, asks on its own once the half day is up; that renews the session too.
  useEffect(() => {
    if (!user) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - askedAt.current >= SESSION_RENEW_MS) askAgain(true);
    }, SESSION_RENEW_MS / 12);
    return () => clearInterval(timer);
  }, [user]);

  async function change<T>(action: () => Promise<T>, who: (result: T) => User | null, signedOut = false): Promise<T> {
    if (changing.current) throw new Error('세션 요청이 진행 중이에요');
    changing.current = true;
    heardMeanwhile.current = false;
    stopAsking();
    try {
      const result = await action();
      // Whatever was asked while it ran answers for the session before it.
      stopAsking();
      if (mounted.current) {
        const next = who(result);
        accept(next, signedOut);
        channel.current?.announce(next?.id ?? null);
      }
      return result;
    } catch (error) {
      if (!ready && mounted.current) check();
      throw error;
    } finally {
      changing.current = false;
      if (heardMeanwhile.current) {
        heardMeanwhile.current = false;
        if (mounted.current) askAgain();
      }
    }
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
