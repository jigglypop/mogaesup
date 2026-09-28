import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { useNavigate } from 'react-router-dom';

import { problemText } from '../api/client';
import { socialApi } from '../api/endpoints';
import type { HomeView, Ilchon, IlchonRequest, IlchonStatus, User } from '../api/types';

/** The home's 일촌, the owner's pending requests, and the visitor's own standing with the owner. */
export function Ilchons({ view, viewer }: { view: HomeView; viewer: User | null }) {
  const { username, ownerName } = view.profile;
  const visitor = viewer && !view.isOwner;
  const navigate = useNavigate();
  const [ilchons, setIlchons] = useState<Ilchon[]>([]);
  const [received, setReceived] = useState<IlchonRequest[]>([]);
  const [status, setStatus] = useState<IlchonStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const [list, requests, standing] = await Promise.all([
      socialApi.ilchons(username),
      view.isOwner ? socialApi.requests() : null,
      visitor ? socialApi.status(username) : null,
    ]);
    setIlchons(list.ilchons);
    setReceived(requests?.received ?? []);
    setStatus(standing);
  }, [username, view.isOwner, visitor]);

  useEffect(() => {
    reload().catch((problem: unknown) => setError(problemText(problem)));
  }, [reload]);

  const act = (action: () => Promise<unknown>) => {
    setError('');
    action()
      .then(reload)
      .catch((problem: unknown) => setError(problemText(problem)));
  };

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
    <section className="mh-card mh-friends">
      <h3>
        일촌 <b>{ilchons.length}</b>
      </h3>

      {received.length > 0 && (
        <ul className="mh-requests" aria-label="받은 일촌 신청">
          {received.map((request) => (
            <li key={request.id}>
              <span className="mh-friend-face">{request.from.emoji}</span>
              <div>
                <b>{request.from.displayName}</b>
                <small>{request.message || `'${request.theirName}'로 불러 달래요`}</small>
              </div>
              <span className="mh-request-actions">
                <button onClick={() => act(() => socialApi.accept(request.id, {}))}>수락</button>
                <button onClick={() => act(() => socialApi.dismiss(request.id))}>거절</button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {ilchons.length === 0 ? (
        <p className="mh-muted">아직 일촌이 없어요</p>
      ) : (
        <ul>
          {ilchons.map((ilchon) => (
            <li key={ilchon.user.id}>
              <span className="mh-friend-face">{ilchon.user.emoji}</span>
              <div>
                <b>{ilchon.user.displayName}</b>
                <small>
                  {ownerName}의 {ilchon.name}
                </small>
              </div>
              <button onClick={() => navigate(`/@${ilchon.user.username}`)}>놀러가기</button>
            </li>
          ))}
        </ul>
      )}

      {visitor && status?.relation === 'none' && !asking && (
        <button className="mh-chip-button mh-wide" onClick={() => setAsking(true)}>
          일촌 신청
        </button>
      )}
      {visitor && asking && (
        <form className="mh-ilchon-form" onSubmit={submitRequest}>
          <label>
            {ownerName}님은 나의
            <input name="name" required maxLength={12} placeholder="베프" />
          </label>
          <label>
            나는 {ownerName}님의
            <input name="theirName" required maxLength={12} placeholder="베프" />
          </label>
          <input name="message" maxLength={100} placeholder="한마디" />
          <div className="mh-request-actions">
            <button type="submit">보내기</button>
            <button type="button" onClick={() => setAsking(false)}>
              취소
            </button>
          </div>
        </form>
      )}
      {visitor && status?.relation === 'requested' && status.request && (
        <div className="mh-ilchon-state">
          <span>일촌 신청을 보냈어요</span>
          <button className="mh-link" onClick={() => act(() => socialApi.dismiss(status.request!.id))}>
            취소
          </button>
        </div>
      )}
      {visitor && status?.relation === 'received' && status.request && (
        <div className="mh-ilchon-state">
          <span>{ownerName}님이 일촌을 신청했어요</span>
          <button className="mh-link" onClick={() => act(() => socialApi.accept(status.request!.id, {}))}>
            수락
          </button>
        </div>
      )}
      {visitor && status?.relation === 'ilchon' && status.ilchon && (
        <div className="mh-ilchon-state">
          <span>일촌 · 나의 {status.ilchon.name}</span>
          <button className="mh-link" onClick={() => act(() => socialApi.unlink(username))}>
            끊기
          </button>
        </div>
      )}
      {error && (
        <p className="mh-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
