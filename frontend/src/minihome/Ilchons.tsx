import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Link } from 'react-router-dom';

import { problemText } from '../api/client';
import { socialApi } from '../api/endpoints';
import type { HomeView, Ilchon, IlchonRequest, IlchonStatus, User } from '../api/types';
import { useSignInPath } from '../auth/signIn';
import { initialOf, REQUESTS_CHANGED, toneOf } from '../shell/Shell';

type Neighbors = {
  list: Ilchon[];
  received: IlchonRequest[];
  status: IlchonStatus | null;
  error: string;
  act: (action: () => Promise<unknown>) => void;
};

/** The island's 이웃 (the server calls them ilchons), the owner's waiting requests, and the visitor's own standing. */
export function useNeighbors(view: HomeView, viewer: User | null): Neighbors {
  const { username } = view.profile;
  const visitor = !!viewer && !view.isOwner;
  const [list, setList] = useState<Ilchon[]>([]);
  const [received, setReceived] = useState<IlchonRequest[]>([]);
  const [status, setStatus] = useState<IlchonStatus | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const [ilchons, requests, standing] = await Promise.all([
      socialApi.ilchons(username),
      view.isOwner ? socialApi.requests() : null,
      visitor ? socialApi.status(username) : null,
    ]);
    setList(ilchons.ilchons);
    setReceived(requests?.received ?? []);
    setStatus(standing);
  }, [username, view.isOwner, visitor]);

  useEffect(() => {
    const load = () => reload().catch((problem: unknown) => setError(problemText(problem)));
    void load();
    // The bell accepts and declines too; either place reloads both.
    window.addEventListener(REQUESTS_CHANGED, load);
    return () => window.removeEventListener(REQUESTS_CHANGED, load);
  }, [reload]);

  const act = useCallback((action: () => Promise<unknown>) => {
    setError('');
    action()
      .then(() => window.dispatchEvent(new Event(REQUESTS_CHANGED)))
      .catch((problem: unknown) => setError(problemText(problem)));
  }, []);
  return { list, received, status, error, act };
}

function Person({ username, name, detail }: { username: string; name: string; detail: string }) {
  return (
    <>
      <span className="mg-avatar" data-tone={toneOf(username)} aria-hidden="true">
        {initialOf(name)}
      </span>
      <div>
        <b>{name}</b>
        <small>{detail}</small>
      </div>
    </>
  );
}

export function NeighborsTab({ view, viewer, neighbors }: { view: HomeView; viewer: User | null; neighbors: Neighbors }) {
  const { username, ownerName } = view.profile;
  const visitor = !!viewer && !view.isOwner;
  const { list, received, status, error, act } = neighbors;
  const [asking, setAsking] = useState(false);
  const signIn = useSignInPath();

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
    <div className="mg-neighbors">
      {received.length > 0 && (
        <section>
          <p className="mg-list-count">
            받은 이웃 신청 <b>{received.length}</b>
          </p>
          <ul className="mg-people">
            {received.map((request) => (
              <li key={request.id}>
                <Person username={request.from.username} name={request.from.displayName} detail={request.message || `'${request.theirName}'로 불러 달래요`} />
                <span className="mg-people-actions">
                  <button className="mg-btn is-primary is-small" onClick={() => act(() => socialApi.accept(request.id, {}))}>
                    수락
                  </button>
                  <button className="mg-btn is-quiet is-small" onClick={() => act(() => socialApi.dismiss(request.id))}>
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
            <input className="mg-field" name="name" required maxLength={12} placeholder="단골 이웃" onKeyDown={(event) => event.stopPropagation()} />
          </label>
          <label className="mg-label">
            나는 {ownerName}님의
            <input className="mg-field" name="theirName" required maxLength={12} placeholder="옆집 이웃" onKeyDown={(event) => event.stopPropagation()} />
          </label>
          <input className="mg-field" name="message" maxLength={100} placeholder="한마디" aria-label="한마디" onKeyDown={(event) => event.stopPropagation()} />
          <div className="mg-row-end">
            <button className="mg-btn is-quiet is-small" type="button" onClick={() => setAsking(false)}>
              취소
            </button>
            <button className="mg-btn is-primary is-small" type="submit">
              보내기
            </button>
          </div>
        </form>
      )}
      {visitor && status?.relation === 'requested' && status.request && (
        <p className="mg-state">
          <span>이웃 신청을 보냈어요</span>
          <button className="mg-link" onClick={() => act(() => socialApi.dismiss(status.request!.id))}>
            취소
          </button>
        </p>
      )}
      {visitor && status?.relation === 'received' && status.request && (
        <p className="mg-state">
          <span>{ownerName}님이 이웃을 신청했어요</span>
          <button className="mg-link" onClick={() => act(() => socialApi.accept(status.request!.id, {}))}>
            수락
          </button>
        </p>
      )}
      {visitor && status?.relation === 'ilchon' && status.ilchon && (
        <p className="mg-state">
          <span>이웃 · 나의 {status.ilchon.name}</span>
          <button className="mg-link" onClick={() => act(() => socialApi.unlink(username))}>
            끊기
          </button>
        </p>
      )}

      <p className="mg-list-count">
        이웃 <b>{list.length}</b>
      </p>
      {list.length === 0 ? (
        <p className="mg-empty">아직 이웃이 없어요</p>
      ) : (
        <ul className="mg-people">
          {list.map((ilchon) => (
            <li key={ilchon.user.id}>
              <Person username={ilchon.user.username} name={ilchon.user.displayName} detail={`${ownerName}의 ${ilchon.name}`} />
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
      {error && (
        <p className="mg-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
