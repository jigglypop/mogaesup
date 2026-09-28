import { useCallback, useEffect, useState } from 'react';

import { Vector3 } from 'three';

import { Link } from 'react-router-dom';

import { useTeleport } from 'gaesup-world';

import type { CatalogItem, HomeView, ProfileChanges, User } from '../api/types';

import { Ilchons } from './Ilchons';
import { RESIDENTS } from './world';

const MOODS = [
  { emoji: '😊', label: '행복' },
  { emoji: '🥰', label: '설렘' },
  { emoji: '😎', label: '여유' },
  { emoji: '😴', label: '졸림' },
];
const STATUS_SAVE_DELAY_MS = 800;

type ProfileProps = {
  view: HomeView;
  viewer: User | null;
  minimes: CatalogItem[];
  onUpdate: (changes: ProfileChanges) => void;
};

/** Saves the status line a moment after typing stops. */
function StatusMessage({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return undefined;
    const timer = setTimeout(() => onSave(draft), STATUS_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, value, onSave]);
  return (
    <textarea
      className="mh-status-message"
      value={draft}
      maxLength={60}
      rows={2}
      placeholder="상태 메시지"
      aria-label="상태 메시지"
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

/** The left column: who lives here, what they wear, their 일촌, and the island's residents. */
export function Profile({ view, viewer, minimes, onUpdate }: ProfileProps) {
  const { profile, isOwner } = view;
  const { teleport, canTeleport } = useTeleport();
  const minime = minimes.find((item) => item.id === profile.minime);
  const saveStatus = useCallback((statusMessage: string) => onUpdate({ statusMessage }), [onUpdate]);

  return (
    <div className="mh-profile">
      <section className="mh-card mh-me">
        <div className="mh-avatar">
          <span>{profile.emoji}</span>
          <em title={MOODS[profile.mood]?.label}>{MOODS[profile.mood]?.emoji}</em>
        </div>
        <div className="mh-me-name">
          <b>{profile.ownerName}</b>
          <small>{minime ? `${minime.label} 미니미` : '미니미'}</small>
        </div>
        {isOwner ? (
          <StatusMessage value={profile.statusMessage} onSave={saveStatus} />
        ) : (
          profile.statusMessage && <p className="mh-status-message">{profile.statusMessage}</p>
        )}
        <div className="mh-moods" role="radiogroup" aria-label="오늘의 기분">
          <span>TODAY IS…</span>
          {MOODS.map((option, index) => (
            <button
              key={option.label}
              role="radio"
              aria-checked={profile.mood === index}
              aria-label={option.label}
              title={option.label}
              disabled={!isOwner}
              onClick={() => onUpdate({ mood: index })}
            >
              {option.emoji}
            </button>
          ))}
        </div>
      </section>

      {isOwner && (
        <section className="mh-card">
          <h3>미니미 바꾸기</h3>
          <div className="mh-minimes">
            {minimes.map((item) => (
              <button
                key={item.id}
                aria-pressed={item.id === profile.minime}
                onClick={() => onUpdate({ minime: item.id, emoji: item.emoji })}
              >
                {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <span>{item.emoji}</span>}
                <small>{item.label}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      <Ilchons view={view} viewer={viewer} />

      <section className="mh-card mh-friends">
        <h3>
          섬 주민 <b>{RESIDENTS.length}</b>
        </h3>
        <ul>
          {RESIDENTS.map((resident) => (
            <li key={resident.id}>
              <span className="mh-friend-face">{resident.emoji}</span>
              <div>
                <b>{resident.name}</b>
                <small>{resident.intro}</small>
              </div>
              <button
                disabled={!canTeleport}
                onClick={() =>
                  teleport(new Vector3(resident.spot[0], 0.2, resident.spot[1] + 2.4), undefined, { dropHeight: 2 })
                }
              >
                찾아가기
              </button>
            </li>
          ))}
        </ul>
      </section>

      {!viewer && (
        <p className="mh-muted mh-center">
          <Link to="/">로그인</Link>하면 일촌 신청과 방명록을 쓸 수 있어요.
        </p>
      )}
    </div>
  );
}
