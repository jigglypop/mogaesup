import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';

import type { CatalogItem, HomeView, HomeVisibility, Look, ProfileChanges } from '../api/types';
import { Icon } from '../ui/icons';
import { wearsLook } from './character';

const MOODS = [
  { emoji: '😊', label: '행복' },
  { emoji: '🥰', label: '설렘' },
  { emoji: '😎', label: '여유' },
  { emoji: '😴', label: '졸림' },
];
const VISIBILITY: { value: HomeVisibility; label: string }[] = [
  { value: 'public', label: '모두' },
  { value: 'ilchon', label: '이웃만' },
  { value: 'private', label: '나만' },
];
const SAVE_DELAY_MS = 800;

/** Whether typing left something to save: more than spaces at the edges, and an empty field only where empty is allowed. */
export function wantsSave(draft: string, saved: string, allowEmpty: boolean): boolean {
  const next = draft.trim();
  return next !== saved && (allowEmpty || next !== '');
}

/** A text field that saves a moment after typing stops. */
function Autosaved({
  value,
  onSave,
  multiline = false,
  allowEmpty = false,
  ...props
}: {
  value: string;
  onSave: (value: string) => void;
  multiline?: boolean;
  allowEmpty?: boolean;
  maxLength: number;
  placeholder: string;
  'aria-label': string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (!wantsSave(draft, value, allowEmpty)) return undefined;
    const timer = setTimeout(() => onSave(draft), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, value, allowEmpty, onSave]);
  const common = {
    ...props,
    className: 'mg-field',
    value: draft,
    onKeyDown: (event: KeyboardEvent) => event.stopPropagation(),
  };
  return multiline ? (
    <textarea {...common} rows={2} onChange={(event) => setDraft(event.target.value)} />
  ) : (
    <input {...common} onChange={(event) => setDraft(event.target.value)} />
  );
}

export function minimeOf(view: HomeView, minimes: CatalogItem[]) {
  return minimes.find((item) => item.id === view.profile.minime);
}

/** The panel's top: who lives here and how they feel today. */
export function ProfileHeader({
  view,
  minimes,
  neighbors,
  onEdit,
}: {
  view: HomeView;
  minimes: CatalogItem[];
  neighbors: number;
  onEdit: () => void;
}) {
  const { profile, visits, isOwner } = view;
  const minime = minimeOf(view, minimes);
  const mood = MOODS[profile.mood];
  return (
    <header className="mg-profile">
      <div className="mg-profile-main">
        <span className="mg-avatar is-large">
          {minime?.thumbnailUrl ? <img src={minime.thumbnailUrl} alt="" /> : profile.emoji}
        </span>
        <div className="mg-profile-text">
          <h2>{profile.ownerName}</h2>
          <p>{profile.statusMessage || (isOwner ? '상태 메시지를 적어 보세요' : ' ')}</p>
        </div>
        {isOwner && (
          <button className="mg-btn is-small" onClick={onEdit}>
            <Icon name="edit" /> 편집
          </button>
        )}
      </div>
      <div className="mg-profile-chips">
        <span className="mg-chip is-soft">이웃 {neighbors}</span>
        <span className="mg-chip is-soft" title={`누적 ${visits.total.toLocaleString()}`}>
          오늘 방문 {visits.today.toLocaleString()}
        </span>
        {mood && (
          <span className="mg-chip is-soft">
            {mood.emoji} {mood.label}
          </span>
        )}
      </div>
    </header>
  );
}

/** 소개: the island's name, the owner's mood and 미니미 (or their own look from the wardrobe), and who may visit. */
export function About({
  view,
  minimes,
  look,
  onUpdate,
  onWearLook,
}: {
  view: HomeView;
  minimes: CatalogItem[];
  look: Look | null;
  onUpdate: (changes: ProfileChanges) => void;
  onWearLook: () => void;
}) {
  const { profile, isOwner } = view;
  const ownLook = wearsLook(look);
  const saveTitle = useCallback((title: string) => onUpdate({ title }), [onUpdate]);
  const saveStatus = useCallback((statusMessage: string) => onUpdate({ statusMessage }), [onUpdate]);

  return (
    <div className="mg-about">
      {isOwner ? (
        <section className="mg-form">
          <label className="mg-label">
            섬 이름
            <Autosaved value={profile.title} onSave={saveTitle} maxLength={30} placeholder="섬 이름" aria-label="섬 이름" />
          </label>
          <label className="mg-label">
            상태 메시지
            <Autosaved value={profile.statusMessage} onSave={saveStatus} maxLength={60} placeholder="오늘은 어떤 날인가요" aria-label="상태 메시지" multiline allowEmpty />
          </label>
          <div className="mg-label">
            오늘 기분
            <div className="mg-tabs" role="radiogroup" aria-label="오늘 기분">
              {MOODS.map((option, index) => (
                <button key={option.label} role="radio" aria-checked={profile.mood === index} onClick={() => onUpdate({ mood: index })}>
                  {option.emoji} {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mg-label">
            누가 놀러 올 수 있나요
            <div className="mg-tabs" role="radiogroup" aria-label="공개 범위">
              {VISIBILITY.map((option) => (
                <button key={option.value} role="radio" aria-checked={profile.visibility === option.value} onClick={() => onUpdate({ visibility: option.value })}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mg-label">
            미니미
            <div className="mg-minimes">
              {look?.modelUrl && (
                <button aria-pressed={ownLook} onClick={() => !ownLook && onWearLook()}>
                  <span aria-hidden="true">
                    <Icon name="person" />
                  </span>
                  <small>내 모습</small>
                </button>
              )}
              {minimes.map((item) => (
                <button key={item.id} aria-pressed={!ownLook && item.id === profile.minime} onClick={() => onUpdate({ minime: item.id, emoji: item.emoji })}>
                  {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <span aria-hidden="true">{item.emoji}</span>}
                  <small>{item.label}</small>
                </button>
              ))}
            </div>
          </div>
        </section>
      ) : (
        <section className="mg-card mg-about-card">
          <b>{profile.title}</b>
          <p className="mg-muted">@{profile.username}</p>
        </section>
      )}

    </div>
  );
}
