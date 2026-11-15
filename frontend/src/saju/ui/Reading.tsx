import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { ApiRequestError, problemText } from '../../api/client';
import { sajuApi } from '../../api/endpoints';
import type { Made, SajuReading } from '../../api/types';
import { Icon } from '../../ui/icons';
import { keyOf, type Birth } from '../engine';
import { readingChartOf } from '../readingChart';

/** How long the server gives a reading or a picture to be made: one pending for longer reads as failed there. */
export const MADE_WAIT_MS = 10 * 60_000;
/** The first look again at something being made, how much longer each wait after it is, and the longest. */
const POLL_FIRST_MS = 3_000;
const POLL_GROWTH = 1.5;
const POLL_LAST_MS = 20_000;

/** What the page knows of something the server makes for a home: `made` is null until the server has said. */
export type MadeState<T> = {
  made: Made<T> | null;
  /** What went wrong with the last request, to say to the viewer. */
  problem: string;
  /** A request to make it is on its way. */
  asking: boolean;
  /** The server makes none now (it has no key, or the month's paid calls are spent): the card is not shown. */
  off?: boolean;
};

type Tagged<T> = MadeState<T> & { key: string | null };
const blank = <T,>(key: string | null): Tagged<T> => ({ key, made: null, problem: '', asking: false, off: false });

/** The server's answer when it makes none now (server/src/saju_made.rs `unavailable`). */
const isOff = (error: unknown) =>
  error instanceof ApiRequestError && error.status === 503 && (error.code === 'reading_unavailable' || error.code === 'picture_unavailable');

/**
 * What the server has made for `key` (a home's birth; null when there is nothing to read), read once and, while `poll`
 * holds and it is being made, again every few seconds, each wait longer than the one before, until it is made or the
 * server's own ten minutes have gone by. `ask` sends a request to make it and shows the state that answer gives; an
 * answer from before the latest request, or for another key, is not shown.
 */
export function useMade<T>({ key, read, poll, gaveUp }: {
  key: string | null;
  read: () => Promise<Made<T>>;
  poll: boolean;
  /** What is said when it is still being made after the ten minutes. */
  gaveUp: string;
}) {
  const [state, setState] = useState<Tagged<T>>(() => blank(key));
  const shown = state.key === key ? state : blank<T>(key);
  const reader = useRef(read);
  reader.current = read;
  const current = useRef(key);
  current.current = key;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Requests to make it, counted: a read that began before the latest of them may hold the state from before it.
  const writes = useRef(0);
  const asking = useRef<string | null>(null);
  /** Shows what was found for `of`, unless the page has moved on to another key or gone. */
  const update = useCallback((of: string, changes: Partial<MadeState<T>>) => {
    if (!alive.current || current.current !== of) return;
    setState((before) => ({ ...(before.key === of ? before : blank<T>(of)), ...changes }));
  }, []);

  /**
   * Reads the state for `of` and shows it, unless a request to make it was sent while the read was on its way. A look
   * while it is being made (`then`, called after it) keeps quiet about a read that failed: the next look reads again.
   */
  const load = useCallback(
    (of: string, then?: () => void) => {
      const began = writes.current;
      Promise.resolve()
        .then(() => reader.current())
        .then(
          (made) => {
            if (began === writes.current) update(of, { made, problem: '' });
            then?.();
          },
          (error: unknown) => {
            if (!then && began === writes.current) update(of, { problem: problemText(error) });
            then?.();
          },
        );
    },
    [update],
  );
  useEffect(() => {
    if (key) load(key);
  }, [key, load]);

  const pending = shown.made?.status === 'pending';
  useEffect(() => {
    if (!key || !poll || !pending) return undefined;
    const of = key;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wait = POLL_FIRST_MS;
    const started = Date.now();
    const next = () => {
      if (!live) return;
      timer = setTimeout(look, wait);
      wait = Math.min(POLL_LAST_MS, wait * POLL_GROWTH);
    };
    const look = () => {
      if (!live) return;
      if (Date.now() - started > MADE_WAIT_MS) {
        update(of, { made: { status: 'failed', code: 'interrupted', message: gaveUp } });
        return;
      }
      // A hidden page, or one sending a request of its own, looks at the next turn.
      if (document.hidden || asking.current === of) next();
      else load(of, next);
    };
    next();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, poll, pending, load, update, gaveUp]);

  const ask = useCallback(
    (send: () => Promise<Made<T>>) => {
      if (!key || asking.current === key) return;
      asking.current = key;
      writes.current += 1;
      update(key, { asking: true, problem: '' });
      Promise.resolve()
        .then(send)
        .then(
          (made) => update(key, { made, asking: false }),
          (error: unknown) => update(key, isOff(error) ? { off: true, asking: false } : { problem: problemText(error), asking: false }),
        )
        .finally(() => {
          if (asking.current === key) asking.current = null;
        });
    },
    [key, update],
  );
  /** Says what went wrong before any request could be sent. */
  const fail = useCallback(
    (problem: string) => {
      if (key) update(key, { problem });
    },
    [key, update],
  );
  const reload = useCallback(() => {
    if (!key) return;
    update(key, { problem: '' });
    load(key);
  }, [key, load, update]);
  return { made: shown.made, problem: shown.problem, asking: shown.asking, off: shown.off, ask, fail, reload };
}

export type ReadingState = MadeState<{ reading: SajuReading }>;

/**
 * A home's reading, written from its chart (`birth`, null while the home is not built). It is read when its tabs are
 * first `shown`; for the owner (`ownerId`) it is asked for then if none is written for this birth, once, and looked at
 * again while it is being written and a tab of it is shown. `ask` asks for it on the owner's say: `again` for a new one
 * in place of the one written.
 */
export function useReading({ username, ownerId, birth, shown }: { username: string; ownerId: string | null; birth: Birth | null; shown: boolean }) {
  const [opened, setOpened] = useState(shown);
  useEffect(() => {
    if (shown) setOpened(true);
  }, [shown]);
  const key = birth && (opened || shown) ? `${username}:${keyOf(birth)}` : null;
  const made = useMade<{ reading: SajuReading }>({ key, read: () => sajuApi.reading(username), poll: !!ownerId && shown, gaveUp: '풀이를 끝내지 못했어요' });
  const { ask: send } = made;
  const ask = useCallback(
    (again: boolean) => {
      if (!ownerId || !birth) return;
      // A chart this version cannot draw is refused here, as the server would refuse it.
      send(async () => sajuApi.read({ expectedOwnerId: ownerId, chart: readingChartOf(birth), ...(again ? { again: true } : {}) }));
    },
    [ownerId, birth, send],
  );
  const asked = useRef(new Set<string>());
  const none = made.made?.status === 'none';
  useEffect(() => {
    if (!ownerId || !key || !shown || !none || asked.current.has(key)) return;
    asked.current.add(key);
    ask(false);
  }, [ownerId, key, shown, none, ask]);
  return { ...made, ask };
}

/** A reading's text as it was written: a paragraph to a line. */
function Paragraphs({ text }: { text: string }) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => <p key={index}>{line}</p>);
}

/** Something being made, as its card says it: what is being done, and a quiet mark that it goes on. */
export function Making({ label }: { label: string }) {
  return (
    <div className="mg-saju-making" role="status">
      <span>{label}</span>
      <span className="mg-progress is-indeterminate" aria-hidden="true">
        <i />
      </span>
    </div>
  );
}

const TITLES = { saju: '사주 풀이', ziwei: '자미두수 풀이' } as const;

/**
 * One part of a home's reading as a card: the 사주's at the head of 사주보기, the 명반's on the 자미두수 tab. Written, it
 * is its summary and then its sections, with `report` (the PDF) in its head; the owner also sees it being written and
 * why it could not be, and may ask for it again. A visitor sees a written reading and nothing else.
 */
export function ReadingCard({ part, state, owner, onAsk, onReload, report }: {
  part: 'saju' | 'ziwei';
  state: ReadingState;
  owner: boolean;
  /** Asks for the reading: `again` for a new one in place of the one written. */
  onAsk: (again: boolean) => void;
  /** Reads the state again, after the server could not be asked. */
  onReload: () => void;
  report: (reading: SajuReading) => ReactNode;
}) {
  const { made, problem, asking, off } = state;
  const title = TITLES[part];
  if (made?.status === 'ready') {
    const text = made.reading[part];
    if (!text) return null;
    return (
      <section className="mg-saju-card mg-saju-reading" aria-label={title}>
        <div className="mg-saju-reading-head">
          <h2 className="mg-heading">{title}</h2>
          <div className="mg-saju-reading-actions">
            {report(made.reading)}
            {owner && (
              <button className="mg-btn is-small" disabled={asking} onClick={() => onAsk(true)}>
                <Icon name="rotate" /> 다시 풀기
              </button>
            )}
          </div>
        </div>
        {owner && problem && (
          <p className="mg-error" role="alert">
            {problem}
          </p>
        )}
        <div className="mg-saju-reading-summary">
          <Paragraphs text={text.summary} />
        </div>
        {text.sections.map((section, index) => (
          <section key={index} className="mg-saju-reading-part">
            <h3>{section.title}</h3>
            <Paragraphs text={section.body} />
          </section>
        ))}
      </section>
    );
  }
  if (!owner) return null;
  if (asking || made?.status === 'pending') {
    return (
      <section className="mg-saju-card mg-saju-reading" aria-label={title} aria-busy="true">
        <h2 className="mg-heading">{title}</h2>
        <Making label="풀이를 쓰고 있어요" />
      </section>
    );
  }
  if (off) return null;
  const failure = made?.status === 'failed' ? made.message : problem;
  if (!failure) return null;
  return (
    <section className="mg-saju-card mg-saju-reading" aria-label={title}>
      <h2 className="mg-heading">{title}</h2>
      <p className="mg-error" role="alert">
        {failure}
      </p>
      {/* Not knowing what the server holds, the page asks it again; otherwise the reading is asked for again. */}
      <button className="mg-btn is-small mg-saju-reading-retry" onClick={() => (made ? onAsk(false) : onReload())}>
        <Icon name="rotate" /> 다시 시도
      </button>
    </section>
  );
}
