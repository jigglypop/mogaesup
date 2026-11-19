import { useRef, useState } from 'react';

import { ApiRequestError, problemText } from '../../api/client';
import type { HomeProfile, ProfileChanges } from '../../api/types';
import { BalloonPicker } from '../../minihome/balloons/BalloonPicker';

const MOODS = [
  { emoji: '😊', label: '행복' },
  { emoji: '🥰', label: '설렘' },
  { emoji: '😎', label: '여유' },
  { emoji: '😴', label: '졸림' },
];

/** The side of the square a profile picture is sent as; the server crops and encodes it again (320 px). */
const AVATAR_SENT = 640;

/** A picture the browser shows, cropped about its middle to a square and sent as a JPEG data URL. */
export async function squarePicture(file: File): Promise<string> {
  if (file.size > 32 * 1024 * 1024) throw new Error('32MB 이하의 사진을 선택해 주세요.');
  const local = URL.createObjectURL(file);
  try {
    const source = new Image();
    source.src = local;
    await source.decode().catch(() => {
      throw new Error('사진을 읽을 수 없어요. JPG, PNG, WebP 사진을 선택해 주세요.');
    });
    const side = Math.min(source.naturalWidth, source.naturalHeight);
    const edge = Math.max(1, Math.min(AVATAR_SENT, side));
    const canvas = document.createElement('canvas');
    canvas.width = edge;
    canvas.height = edge;
    const paper = canvas.getContext('2d');
    if (!paper) throw new Error('사진을 준비하지 못했어요.');
    paper.fillStyle = '#ffffff';
    paper.fillRect(0, 0, edge, edge);
    paper.imageSmoothingQuality = 'high';
    paper.drawImage(source, (source.naturalWidth - side) / 2, (source.naturalHeight - side) / 2, side, side, 0, 0, edge, edge);
    return canvas.toDataURL('image/jpeg', 0.88);
  } finally {
    URL.revokeObjectURL(local);
  }
}

/** The owner's profile picture, name, island title, status, mood and balloon. */
export function ProfileCard({ profile, onSave, onAvatar }: {
  profile: HomeProfile;
  onSave: (changes: ProfileChanges) => Promise<void>;
  /** Puts up (a data URL) or takes down (null) the profile picture. */
  onAvatar?: ((image: string | null) => Promise<void>) | undefined;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [picturing, setPicturing] = useState(false);
  const changePicture = (file: File | null) => {
    if (!onAvatar || picturing) return;
    setPicturing(true);
    setProblem('');
    (file ? squarePicture(file).then((image) => onAvatar(image)) : onAvatar(null))
      .catch((error: unknown) => setProblem(error instanceof ApiRequestError || !(error instanceof Error) ? problemText(error) : error.message))
      .finally(() => setPicturing(false));
  };
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
      {onAvatar && (
        <div className="mg-saju-avatar-edit" aria-busy={picturing}>
          {profile.avatarUrl ? <img className="mg-saju-avatar" src={profile.avatarUrl} alt="프로필 사진" width={64} height={64} /> : <span className="mg-saju-avatar is-empty" aria-hidden="true" />}
          <input
            ref={picker}
            type="file"
            hidden
            aria-label="프로필 사진 파일"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) changePicture(file);
            }}
          />
          <button className="mg-btn is-small" type="button" disabled={picturing} onClick={() => picker.current?.click()}>
            {profile.avatarUrl ? '사진 바꾸기' : '사진 올리기'}
          </button>
          {profile.avatarUrl && (
            <button className="mg-btn is-small" type="button" disabled={picturing} onClick={() => changePicture(null)}>
              사진 내리기
            </button>
          )}
        </div>
      )}
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
