import { useState } from 'react';

import { problemText } from '../../api/client';
import type { HomeProfile, ProfileChanges } from '../../api/types';
import { BalloonPicker } from '../../minihome/balloons/BalloonPicker';

const MOODS = [
  { emoji: '😊', label: '행복' },
  { emoji: '🥰', label: '설렘' },
  { emoji: '😎', label: '여유' },
  { emoji: '😴', label: '졸림' },
];

/** The owner's name, island title, status, mood and balloon. */
export function ProfileCard({ profile, onSave }: { profile: HomeProfile; onSave: (changes: ProfileChanges) => Promise<void> }) {
  const [name, setName] = useState(profile.ownerName);
  const [title, setTitle] = useState(profile.title);
  const [status, setStatus] = useState(profile.statusMessage);
  const [mood, setMood] = useState(profile.mood);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const save = () => {
    if (busy) return;
    const nextName = name.trim();
    const nextTitle = title.trim();
    const changes: ProfileChanges = {};
    if (nextName && nextName !== profile.ownerName) changes.displayName = nextName;
    if (nextTitle && nextTitle !== profile.title) changes.title = nextTitle;
    if (status.trim() !== profile.statusMessage) changes.statusMessage = status.trim();
    if (mood !== profile.mood) changes.mood = mood;
    if (Object.keys(changes).length === 0) return;
    setBusy(true);
    setProblem('');
    onSave(changes)
      .catch((error: unknown) => setProblem(problemText(error)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="mg-saju-card" aria-label="프로필">
      <h2 className="mg-heading">프로필</h2>
      <label className="mg-label">
        이름
        <input className="mg-field" aria-label="이름" maxLength={20} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="mg-label">
        섬 이름
        <input className="mg-field" aria-label="섬 이름" maxLength={30} value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="mg-label">
        상태 메시지
        <textarea className="mg-field" aria-label="상태 메시지" maxLength={60} rows={2} value={status} onChange={(event) => setStatus(event.target.value)} />
      </label>
      <div className="mg-label">
        오늘 기분
        <div className="mg-tabs" role="radiogroup" aria-label="오늘 기분">
          {MOODS.map((option, index) => (
            <button key={option.label} type="button" role="radio" aria-checked={mood === index} onClick={() => setMood(index)}>
              {option.emoji} {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mg-label">
        말풍선
        <BalloonPicker value={profile.balloon} onPick={(balloon) => void onSave({ balloon }).catch((error: unknown) => setProblem(problemText(error)))} />
      </div>
      <button className="mg-btn is-small" type="button" disabled={busy} onClick={save}>
        저장
      </button>
      {problem && (
        <p className="mg-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
