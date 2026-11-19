import './social.css';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { Link } from 'react-router-dom';

import { problemText } from '../api/client';
import { socialApi } from '../api/endpoints';
import type { HomeView, Ilchon, IlchonRequest, IlchonStatus, User } from '../api/types';
import { useSignInPath } from '../auth/signIn';
import { initialOf, REQUESTS_CHANGED, toneOf } from '../shell/Shell';

export type Neighbors = {
  list: Ilchon[];
  /** Whether `list` is what the server answered: not until it has been read, and not when it could not be. */
  loaded: boolean;
  received: IlchonRequest[];
  status: IlchonStatus | null;
  error: string;
  /** An action is on its way; the others wait for it. */
  busy?: boolean;
  act: (action: () => Promise<unknown>) => void;
};

/** The island's 이웃 (the server calls them ilchons), the owner's waiting requests, and the visitor's own standing. */
export function useNeighbors(view: HomeView, viewer: User | null): Neighbors {
  const { username } = view.profile;
  const viewerId = viewer?.id ?? null;
  const visitor = !!viewer && !view.isOwner;
  // Kept with the 섬 it was read for: a page that goes on to another 섬 shows none of the last one's.
  const [read, setRead] = useState<{ of: string; list: Ilchon[] } | null>(null);
  const list = useMemo(() => (read?.of === username ? read.list : []), [read, username]);
  const loaded = read?.of === username;
  const [received, setReceived] = useState<IlchonRequest[]>([]);
  const [status, setStatus] = useState<IlchonStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actError, setActError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Counts reads: an answer a later read overtook (or one for the viewer before) is dropped. */
  const reads = useRef(0);
  const acting = useRef(false);
  const viewing = useRef(viewerId);
  viewing.current = viewerId;

  const reload = useCallback(async () => {
    const mine = ++reads.current;
    try {
      const [ilchons, requests, standing] = await Promise.all([
        socialApi.ilchons(username),
        view.isOwner ? socialApi.requests() : null,
        visitor ? socialApi.status(username) : null,
      ]);
      if (mine !== reads.current) return;
      setRead({ of: username, list: ilchons.ilchons });
      setReceived(requests?.received ?? []);
      setStatus(standing);
      setLoadError('');
    } catch (problem) {
      if (mine === reads.current) setLoadError(problemText(problem));
    }
  }, [username, view.isOwner, visitor]);

  // A different viewer reads again: the standing is their own. Another 섬 (or viewer) shows none of the requests and
  // problems read before it, even while its own read is on its way or when that read fails.
  useEffect(() => {
    setStatus(null);
    setReceived([]);
    setLoadError('');
    setActError('');
    const load = () => void reload();
    load();
    // The bell accepts and declines too; either place reloads both.
    window.addEventListener(REQUESTS_CHANGED, load);
    return () => {
      reads.current++;
      window.removeEventListener(REQUESTS_CHANGED, load);
    };
  }, [reload, viewerId]);

  const act = useCallback((action: () => Promise<unknown>) => {
    if (acting.current) return;
    const mine = viewing.current;
    acting.current = true;
    setBusy(true);
    setActError('');
    action()
      .then(() => window.dispatchEvent(new Event(REQUESTS_CHANGED)))
      .catch((problem: unknown) => {
        if (viewing.current === mine) setActError(problemText(problem));
      })
      .finally(() => {
        acting.current = false;
        setBusy(false);
      });
  }, []);
  return { list, loaded, received, status, error: actError || loadError, busy, act };
}

function Person({ username, name, detail, avatarUrl }: { username: string; name: string; detail: string; avatarUrl?: string | null | undefined }) {
  return (
    <>
      <span className="mg-avatar" data-tone={toneOf(username)} aria-hidden="true">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : initialOf(name)}
      </span>
      <div>
        <b>{name}</b>
        <small>{detail}</small>
      </div>
    </>
  );
}

/**
 * What can be done about 이웃 here: the owner's waiting requests, and the visitor's own standing with the owner (asking,
 * a request on its way from either side, or 이웃 already).
 */
export function NeighborActions({ view, viewer, neighbors }: { view: HomeView; viewer: User | null; neighbors: Neighbors }) {
  const { username, ownerName } = view.profile;
  const visitor = !!viewer && !view.isOwner;
  const { received, status, error, busy, act } = neighbors;
  const [asking, setAsking] = useState(false);

  const submitRequest = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    act(async () => {
      await socialApi.request(username, { name: text('name'), theirName: text('theirName'), message: text('message') });
      setAsking(false);
    });
  };

  return (
    <>
      {received.length > 0 && (
        <section>
          <p className="mg-list-count">
            받은 이웃 신청 <b>{received.length}</b>
          </p>
          <ul className="mg-people">
            {received.map((request) => (
              <li key={request.id}>
                <Person username={request.from.username} name={request.from.displayName} avatarUrl={request.from.avatarUrl} detail={request.message || `'${request.theirName}'로 불러 달래요`} />
                <span className="mg-people-actions">
                  <button className="mg-btn is-primary is-small" aria-disabled={busy || undefined} onClick={() => act(() => socialApi.accept(request.id, {}))}>
                    수락
                  </button>
                  <button className="mg-btn is-quiet is-small" aria-disabled={busy || undefined} onClick={() => act(() => socialApi.dismiss(request.id))}>
                    거절
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {visitor && status?.relation === 'none' && !asking && (
        <button className="mg-btn is-primary is-wide" onClick={() => setAsking(true)}>
          이웃 신청
        </button>
      )}
      {visitor && asking && (
        <form className="mg-card mg-neighbor-form" onSubmit={submitRequest}>
          <label className="mg-label">
            {ownerName}님은 나의
            <input className="mg-field" name="name" required maxLength={12} onKeyDown={(event) => event.stopPropagation()} />
          </label>
          <label className="mg-label">
            나는 {ownerName}님의
            <input className="mg-field" name="theirName" required maxLength={12} onKeyDown={(event) => event.stopPropagation()} />
          </label>
          <input className="mg-field" name="message" maxLength={100} placeholder="한마디" aria-label="한마디" onKeyDown={(event) => event.stopPropagation()} />
          <div className="mg-row-end">
            <button className="mg-btn is-quiet is-small" type="button" onClick={() => setAsking(false)}>
              취소
            </button>
            <button className="mg-btn is-primary is-small" type="submit" aria-disabled={busy || undefined}>
              보내기
            </button>
          </div>
        </form>
      )}
      {visitor && status?.relation === 'requested' && status.request && (
        <p className="mg-state">
          <span>이웃 신청을 보냈어요</span>
          <button className="mg-link" aria-disabled={busy || undefined} onClick={() => act(() => socialApi.dismiss(status.request!.id))}>
            취소
          </button>
        </p>
      )}
      {visitor && status?.relation === 'received' && status.request && (
        <p className="mg-state">
          <span>{ownerName}님이 이웃을 신청했어요</span>
          <button className="mg-link" aria-disabled={busy || undefined} onClick={() => act(() => socialApi.accept(status.request!.id, {}))}>
            수락
          </button>
        </p>
      )}
      {visitor && status?.relation === 'ilchon' && status.ilchon && (
        <p className="mg-state">
          <span>이웃 · 나의 {status.ilchon.name}</span>
          <button className="mg-link" aria-disabled={busy || undefined} onClick={() => act(() => socialApi.unlink(username))}>
            끊기
          </button>
        </p>
      )}
      {error && (
        <p className="mg-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function NeighborsTab({ view, viewer, neighbors }: { view: HomeView; viewer: User | null; neighbors: Neighbors }) {
  const { ownerName } = view.profile;
  const { list } = neighbors;
  const signIn = useSignInPath();
  return (
    <div className="mg-neighbors">
      <NeighborActions view={view} viewer={viewer} neighbors={neighbors} />
      <p className="mg-list-count">
        이웃 <b>{list.length}</b>
      </p>
      {list.length === 0 ? (
        <p className="mg-empty">아직 이웃이 없어요</p>
      ) : (
        <ul className="mg-people">
          {list.map((ilchon) => (
            <li key={ilchon.user.id}>
              <Person username={ilchon.user.username} name={ilchon.user.displayName} avatarUrl={ilchon.user.avatarUrl} detail={`${ownerName}의 ${ilchon.name}`} />
              <Link className="mg-btn is-small" to={`/@${ilchon.user.username}`}>
                놀러가기
              </Link>
            </li>
          ))}
        </ul>
      )}
      {!viewer && (
        <p className="mg-center">
          <Link className="mg-btn is-small" to={signIn}>
            로그인
          </Link>
        </p>
      )}
    </div>
  );
}
