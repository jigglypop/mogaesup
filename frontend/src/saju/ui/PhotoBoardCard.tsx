import { useRef, useState } from 'react';

import type { PhotoBoard } from '../../api/types';
import './photoBoard.css';

/** Copy only the visible pixels, keeping the orientation and proportions the browser displays. */
export async function prepareBoardPhoto(file: File): Promise<string> {
  if (file.size > 32 * 1024 * 1024) throw new Error('32MB 이하의 사진을 선택해 주세요.');
  const local = URL.createObjectURL(file);
  try {
    const source = new Image();
    source.src = local;
    await source.decode().catch(() => { throw new Error('사진을 읽을 수 없어요. JPG, PNG, WebP 사진을 선택해 주세요.'); });
    const ratio = Math.min(1, 1280 / Math.max(source.naturalWidth, source.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(source.naturalHeight * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('사진을 준비하지 못했어요.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', 0.86);
    return image.length > Math.ceil(1024 * 1024 / 3) * 4 ? canvas.toDataURL('image/jpeg', 0.66) : image;
  } finally {
    URL.revokeObjectURL(local);
  }
}

export type BoardPicture = PhotoBoard & { url: string };

export function PhotoBoardCard({ photo, onChange, onOpen }: {
  photo: BoardPicture | null;
  onChange?: ((image: string | null) => Promise<string>) | undefined;
  onOpen: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  if (!photo && !onChange) return null;
  const change = async (file: File | null) => {
    if (!onChange || busy) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const issue = await onChange(file ? await prepareBoardPhoto(file) : null);
      if (issue) throw new Error(issue);
      setMessage(file ? '사진을 걸었어요.' : '사진을 내렸어요.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '사진을 저장하지 못했어요.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mg-photo-board" aria-label="사진 전광판" aria-busy={busy}>
      {!onChange && <h3>사진 전광판</h3>}
      {photo && <button type="button" className="mg-photo-board-thumb" onClick={onOpen} aria-label="전광판 사진 크게 보기" aria-haspopup="dialog">
        <img src={photo.url} alt="" width={photo.width} height={photo.height} />
      </button>}
      {onChange && <div className="mg-photo-board-actions">
        <input type="file" hidden ref={input} aria-label="전광판 사진 파일" accept="image/jpeg,image/png,image/webp" onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void change(file);
        }} />
        <button type="button" className="mg-btn is-small" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? '처리 중…' : photo ? '사진 교체' : '사진 올리기'}
        </button>
        {photo && <button type="button" className="mg-btn is-small" disabled={busy} onClick={() => void change(null)}>사진 내리기</button>}
      </div>}
      {error ? <p className="mg-error" role="alert">{error}</p> : message && <p className="mg-muted" role="status">{message}</p>}
    </section>
  );
}
