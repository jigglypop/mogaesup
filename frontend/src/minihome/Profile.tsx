import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { problemText } from '../api/client';
import type { CatalogItem, HomeView, HomeVisibility, Look, ProfileChanges } from '../api/types';
import { draftKey } from '../auth/drafts';
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

/** Text typed but not saved yet, kept in this browser with the saved value it was typed over. */
type Draft = { text: string; base: string };

function readDraft(key: string): Draft | null {
  try {
    const raw = localStorage.getItem(key);
    const draft: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof draft === 'object' && draft !== null && typeof (draft as Draft).text === 'string' && typeof (draft as Draft).base === 'string') {
      return draft as Draft;
    }
  } catch {
    // Storage may be unavailable, or hold something else under the key.
  }
  return null;
}
function keepDraft(key: string, draft: Draft) {
  try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* Keep the live draft even without storage. */ }
}
function dropDraft(key: string) {
  try { localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
}

/**
 * What a field opens with: a kept draft while the server still has the value it was typed over; once the server holds
 * something newer (saved from another tab or device), that wins and the draft goes.
 */
export function openingText(storageKey: string, value: string): string {
  const kept = readDraft(storageKey);
  if (kept && kept.base === value) return kept.text;
  if (kept) dropDraft(storageKey);
  return value;
}

/** A text field that saves a moment after typing stops. */
function Autosaved({
  value,
  onSave,
  multiline = false,
  allowEmpty = false,
  storageKey,
  ...props
}: {
  value: string;
  onSave: (value: string) => void | Promise<void>;
  storageKey: string;
  multiline?: boolean;
  allowEmpty?: boolean;
  maxLength: number;
  placeholder: string;
  'aria-label': string;
}) {
  const [draft, setDraft] = useState(() => openingText(storageKey, value));
  const [error, setError] = useState('');
  const current = useRef({ draft, value, allowEmpty, onSave, storageKey });
  const saved = useRef(value);
  const mounted = useRef(true);
  const inflight = useRef<Promise<void> | null>(null);
  useEffect(() => {
    const typed = current.current.draft;
    // A newer saved value takes the field unless something typed still waits to be saved, or the field already says the
    // same: the answer to a save must not take away the space being typed after a word.
    if (!wantsSave(typed, saved.current, allowEmpty) && typed.trim() !== value) setDraft(value);
    saved.current = value;
  }, [value, allowEmpty]);
  current.current = { draft, value, allowEmpty, onSave, storageKey };
  const flush = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    const { draft, allowEmpty, onSave, storageKey } = current.current;
    const next = draft.trim();
    if (!wantsSave(next, saved.current, allowEmpty)) return Promise.resolve();
    const run = Promise.resolve().then(() => onSave(next)).then(() => {
      saved.current = next;
      // What was typed while it saved now builds on the saved text.
      const typed = current.current.draft;
      if (typed.trim() === next) dropDraft(storageKey);
      else keepDraft(storageKey, { text: typed, base: next });
      if (mounted.current) setError('');
    }, (problem: unknown) => {
      if (mounted.current) setError(problemText(problem));
      throw problem;
    }).finally(() => { inflight.current = null; });
    inflight.current = run;
    return run;
  }, []);
  const savePending = useCallback(() => {
    void flush().then(() => {
      if (wantsSave(current.current.draft, saved.current, current.current.allowEmpty)) savePending();
    }).catch(() => undefined);
  }, [flush]);
  useEffect(() => {
    if (draft.trim() === saved.current && !inflight.current) dropDraft(storageKey);
    else keepDraft(storageKey, { text: draft, base: saved.current });
    if (!wantsSave(draft, saved.current, allowEmpty)) return undefined;
    const timer = setTimeout(savePending, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, value, allowEmpty, storageKey, savePending]);
  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.visibilityState === 'hidden') savePending(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', savePending);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', savePending);
      savePending();
    };
  }, [savePending]);
  const common = {
    ...props,
    className: 'mg-field',
    value: draft,
    onBlur: savePending,
    onKeyDown: (event: KeyboardEvent) => event.stopPropagation(),
  };
  const edit = (next: string) => {
    current.current.draft = next;
    keepDraft(storageKey, { text: next, base: saved.current });
    setDraft(next);
  };
  return <>
    {multiline ? <textarea {...common} rows={2} onChange={(event) => edit(event.target.value)} />
      : <input {...common} onChange={(event) => edit(event.target.value)} />}
    {error && <span className="mg-error" role="alert">{error} <button className="mg-link" type="button" onClick={savePending}>다시 저장</button></span>}
  </>;
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
          <p>{profile.statusMessage || (isOwner ? '상태 메시지 없음' : ' ')}</p>
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
  onUpdate: (changes: ProfileChanges) => void | Promise<void>;
  onWearLook: () => void | Promise<void>;
}) {
  const { profile, isOwner } = view;
  const ownLook = wearsLook(look);
  const saveTitle = useCallback((title: string) => onUpdate({ title }), [onUpdate]);
  const saveStatus = useCallback((statusMessage: string) => onUpdate({ statusMessage }), [onUpdate]);
  const update = (changes: ProfileChanges) => { void Promise.resolve(onUpdate(changes)).catch(() => undefined); };

  return (
    <div className="mg-about">
      {isOwner ? (
        <section className="mg-form">
          <label className="mg-label">
            섬 이름
            <Autosaved key={`${profile.ownerId}:title`} storageKey={draftKey(profile.ownerId, 'title')} value={profile.title} onSave={saveTitle} maxLength={30} placeholder="섬 이름" aria-label="섬 이름" />
          </label>
          <label className="mg-label">
            상태 메시지
            <Autosaved key={`${profile.ownerId}:status`} storageKey={draftKey(profile.ownerId, 'status')} value={profile.statusMessage} onSave={saveStatus} maxLength={60} placeholder="오늘은 어떤 날인가요" aria-label="상태 메시지" multiline allowEmpty />
          </label>
          <div className="mg-label">
            오늘 기분
            <div className="mg-tabs" role="radiogroup" aria-label="오늘 기분">
              {MOODS.map((option, index) => (
                <button key={option.label} role="radio" aria-checked={profile.mood === index} onClick={() => update({ mood: index })}>
                  {option.emoji} {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mg-label">
            누가 놀러 올 수 있나요
            <div className="mg-tabs" role="radiogroup" aria-label="공개 범위">
              {VISIBILITY.map((option) => (
                <button key={option.value} role="radio" aria-checked={profile.visibility === option.value} onClick={() => update({ visibility: option.value })}>
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
                <button key={item.id} aria-pressed={!ownLook && item.id === profile.minime} onClick={() => update({ minime: item.id, emoji: item.emoji })}>
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
