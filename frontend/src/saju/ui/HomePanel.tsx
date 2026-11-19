import { useState, type ReactNode } from 'react';

import { Link } from 'react-router-dom';

import { problemText } from '../../api/client';
import type { HomeView, HomeVisibility, ProfileChanges, User } from '../../api/types';
import { useSignInPath } from '../../auth/signIn';
import { Guestbook } from '../../minihome/Guestbook';
import { NeighborActions, type Neighbors } from '../../minihome/Ilchons';
import { Icon } from '../../ui/icons';
import type { Compat } from '../compat';
import { houseName, type Profile } from '../profile';
import { editPath } from '../routes';
import { Gauge } from './Gauge';
import { PixelIcon } from './PixelIcon';
import { ProfileCard } from './ProfileCard';

/** The bridge between the viewer's home and this one: 이웃 build it, and it stands between two built homes. */
export type Bridge = {
  /** What the two charts find in each other; null until both homes are built. */
  compat: Compat | null;
  /** The stage can show the two homes with the bridge between them, and is showing them. */
  canShow: boolean;
  shown: boolean;
  onShow: (shown: boolean) => void;
};

/**
 * 궁합 다리, on someone else's 섬: the way to become 이웃, and between 이웃 what the two charts found in each
 * other. On one's own it holds the requests waiting for an answer.
 */
function BridgeCard({ view, viewer, neighbors, bridge }: { view: HomeView; viewer: User | null; neighbors: Neighbors; bridge: Bridge }) {
  const signIn = useSignInPath();
  if (view.isOwner) {
    if (neighbors.received.length === 0 && !neighbors.error) return null;
    return (
      <section className="mg-saju-card mg-saju-bridge mg-neighbors" aria-label="이웃 신청">
        <NeighborActions view={view} viewer={viewer} neighbors={neighbors} />
      </section>
    );
  }
  const joined = neighbors.status?.relation === 'ilchon';
  return (
    <section className={`mg-saju-card mg-saju-bridge mg-neighbors${joined && bridge.compat ? ' is-built' : ''}`} aria-label="궁합 다리">
      <h2 className="mg-heading">궁합 다리</h2>
      {joined && bridge.compat && (
        <>
          <p className="mg-saju-bridge-line">{bridge.compat.headline}</p>
          <ul className="mg-saju-notes">
            {bridge.compat.notes.map((note) => (
              <li key={note} className="mg-chip is-soft">
                {note}
              </li>
            ))}
          </ul>
          {bridge.canShow && (
            <button className="mg-btn is-small" aria-pressed={bridge.shown} onClick={() => bridge.onShow(!bridge.shown)}>
              <Icon name={bridge.shown ? 'island' : 'link'} /> {bridge.shown ? '집 보기' : '다리 보기'}
            </button>
          )}
        </>
      )}
      {viewer ? (
        <NeighborActions view={view} viewer={viewer} neighbors={neighbors} />
      ) : (
        <Link className="mg-btn is-wide" to={signIn}>
          로그인
        </Link>
      )}
    </section>
  );
}

const VISIBILITY: { value: HomeVisibility; label: string }[] = [
  { value: 'public', label: '모두' },
  { value: 'ilchon', label: '이웃만' },
  { value: 'private', label: '나만' },
];

/** Who may see the home, and with it the birth its chart is read from: the owner's to say, after they agree. */
function Doors({ visibility, consented, onChange }: {
  visibility: HomeVisibility;
  /** `false` until the owner agrees that visitors may see the birth, chart and reading. */
  consented: boolean;
  onChange: (visibility: HomeVisibility, consent?: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [pending, setPending] = useState<HomeVisibility | null>(null);
  const [agreed, setAgreed] = useState(false);
  const send = (value: HomeVisibility, consent = false) => {
    if (busy) return;
    setBusy(true);
    setProblem('');
    (consent ? onChange(value, true) : onChange(value))
      .then(() => setPending(null))
      .catch((error: unknown) => setProblem(problemText(error)))
      .finally(() => setBusy(false));
  };
  const pick = (value: HomeVisibility) => {
    if (busy || (value === visibility && (value === 'private' || consented))) return;
    if (value !== 'private' && !consented) {
      setPending(value);
      setAgreed(false);
      return;
    }
    send(value);
  };
  const asking = pending ?? (!consented && visibility !== 'private' ? visibility : null);
  return (
    <section className="mg-saju-card" aria-label="공개 범위">
      <h2 className="mg-heading">누가 놀러 올 수 있나요</h2>
      <div className="mg-tabs" role="radiogroup" aria-label="공개 범위">
        {VISIBILITY.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={visibility === option.value} disabled={busy} onClick={() => pick(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
      {asking && (
        <form
          className="mg-saju-consent"
          onSubmit={(event) => {
            event.preventDefault();
            if (agreed) send(asking, true);
          }}
        >
          <p>생년월일, 사주, 풀이를 방문자가 볼 수 있습니다.</p>
          <label>
            <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /> 동의합니다
          </label>
          <button className="mg-btn is-small" type="submit" disabled={busy || !agreed}>
            공개
          </button>
        </form>
      )}
      {problem && (
        <p className="mg-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

/**
 * A 섬's story beside its canvas: the day master in a line, the house and guardian the chart gave, the picture
 * of its island, the balance of elements, the bridge to it and its guestbook. A home not built yet has its bridge and
 * guestbook all the same: a visitor finds them under the empty plot, the owner under the card that builds the home.
 */
export function HomePanel({ view, viewer, profile, picture, decor, neighbors, bridge, onVisibility, onProfile, onGuestbook }: {
  view: HomeView;
  viewer: User | null;
  /** The home's chart, once its owner has built it. */
  profile: Profile | null;
  /** The card with the picture of the built home's island. */
  picture?: ReactNode;
  /** The card that decorates the built home's island (its owner's), or gives it a flag (a visitor's). */
  decor?: ReactNode;
  neighbors: Neighbors;
  bridge: Bridge;
  /** Changes who may see the home: its owner's. `consent` records the agreement to share the chart. */
  onVisibility: (visibility: HomeVisibility, consent?: boolean) => Promise<void>;
  /** Saves the owner's profile. */
  onProfile?: ((changes: ProfileChanges) => Promise<void>) | undefined;
  /** Told when a line is left in the guestbook or taken away (the island's 기념 방명록 hangs them). */
  onGuestbook?: (() => void) | undefined;
}) {
  const { username } = view.profile;
  return (
    <>
      {profile ? (
        <>
          <section className="mg-saju-card mg-saju-who" aria-label="사주 요약">
            <span className="mg-saju-who-mark">
              <PixelIcon name={profile.balance.dominant} size={30} />
            </span>
            <div className="mg-saju-who-text">
              <p className="mg-saju-badge">{profile.badge}</p>
              <ul className="mg-saju-notes">
                <li className="mg-chip is-soft">{houseName(profile.house)}</li>
                <li className="mg-chip is-soft">
                  {profile.guardian.name} · {profile.guardian.pillar}
                </li>
                {profile.guardian.charms.map((item) => (
                  <li key={item.charm} className="mg-chip is-soft">
                    {item.label}
                  </li>
                ))}
              </ul>
              {view.isOwner && (
                <Link className="mg-btn is-small mg-saju-who-edit" to={editPath(username)}>
                  <Icon name="edit" /> 사주 다시 입력
                </Link>
              )}
            </div>
          </section>
          {picture}
          {decor}
          <section className="mg-saju-card" aria-label="오행 밸런스">
            <h2 className="mg-heading">오행 밸런스</h2>
            <Gauge balance={profile.balance} />
          </section>
        </>
      ) : view.isOwner ? null : (
        <section className="mg-saju-card mg-saju-who" aria-label="빈 터">
          <span className="mg-saju-who-mark">
            <PixelIcon name="house" size={30} />
          </span>
          <div className="mg-saju-who-text">
            <p className="mg-saju-badge">빈 터</p>
          </div>
        </section>
      )}
      {view.isOwner && onProfile && <ProfileCard profile={view.profile} onSave={onProfile} />}
      {view.isOwner && <Doors visibility={view.profile.visibility} consented={view.profile.sajuShareConsent !== false} onChange={onVisibility} />}
      <BridgeCard view={view} viewer={viewer} neighbors={neighbors} bridge={bridge} />
      <section className="mg-saju-guestbook" aria-label="방명록">
        <h2 className="mg-heading">방명록</h2>
        <Guestbook username={username} viewer={viewer} onChange={onGuestbook} />
      </section>
    </>
  );
}
