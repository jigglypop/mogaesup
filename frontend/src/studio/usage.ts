import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { catalogApi } from '../api/endpoints';
import type { FactoryUsage } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/can';

/** How often the studio page asks again how far the character server lets its screens go. */
export const USAGE_REFRESH_MS = 60_000;

/**
 * The character server's usage (connected, FACTORY_ACCESS, this month's paid requests): read on mount, then every
 * minute while the page is open and in view, and when it comes back into view. `failed` says the latest read got no
 * answer, which is not the same as the server answering "not connected"; the last answer is kept meanwhile.
 */
export function useFactoryUsage() {
  const [usage, setUsage] = useState<FactoryUsage | null>(null), [failed, setFailed] = useState(false);
  const alive = useRef(true), reading = useRef(false);
  const read = useCallback(() => {
    if (reading.current || !alive.current) return;
    reading.current = true;
    catalogApi.factoryUsage().then(
      (value) => {
        if (!alive.current) return;
        // The same answer keeps the same object, so the screens reading it do not render again every minute.
        setUsage((current) => (current && JSON.stringify(current) === JSON.stringify(value) ? current : value));
        setFailed(false);
      },
      () => { if (alive.current) setFailed(true); },
    ).finally(() => { reading.current = false; });
  }, []);
  useEffect(() => {
    alive.current = true;
    read();
    const timer = window.setInterval(() => { if (!document.hidden) read(); }, USAGE_REFRESH_MS);
    const shown = () => { if (!document.hidden) read(); };
    document.addEventListener('visibilitychange', shown);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [read]);
  return { usage, failed, refresh: read };
}

/** The usage the studio page last read, for the screens inside it; null outside that page or before it knows. */
export const FactoryUsageContext = createContext<FactoryUsage | null>(null);

/**
 * Whether the viewer may start paid studio work, or open a screen made for it: a paid operator (the gate the studio's
 * menu uses, so such a button never bounces back), and, once the studio page knows the server's FACTORY_ACCESS, only
 * when it allows paid work. The server still decides every request.
 */
export function usePaidWork(): boolean {
  const { user } = useAuth();
  const usage = useContext(FactoryUsageContext);
  return can(user, 'paid_operator') && (usage === null || (usage.connected && usage.access === 'paid'));
}
