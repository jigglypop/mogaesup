import { useEffect, useState } from 'react';
import { decodePhoto, FULL_PHOTO, preparePhoto, type DecodedPhoto, type PhotoCrop } from '../photo-preparation';

/** How long the crop must rest before the photo is encoded again: a slider being dragged moves only the frame. */
const ENCODE_DELAY_MS = 200;
const cropKey = (crop: PhotoCrop) => `${crop.x}:${crop.y}:${crop.width}:${crop.height}`;

export function PhotoPreparation({ file, busy, onUpload, onCancel }: { file: File; busy: boolean; onUpload(file: File): Promise<void>; onCancel(): void }) {
  const [photo, setPhoto] = useState<DecodedPhoto | null>(null), [crop, setCrop] = useState<PhotoCrop>({ ...FULL_PHOTO });
  const [prepared, setPrepared] = useState<{ file: File; width: number; height: number; url: string } | null>(null);
  const [error, setError] = useState(''), [processing, setProcessing] = useState(true), [sourceUrl, setSourceUrl] = useState('');
  // The crop the prepared file was (or is being) encoded with.
  const [settled, setSettled] = useState<PhotoCrop>({ ...FULL_PHOTO });
  useEffect(() => {
    let active = true, decoded: DecodedPhoto | undefined;
    const url = URL.createObjectURL(file); setSourceUrl(url); setPhoto(null); setPrepared(null); setProcessing(true); setCrop({ ...FULL_PHOTO }); setSettled({ ...FULL_PHOTO }); setError('');
    void decodePhoto(file).then(value => { decoded = value; if (active) setPhoto(value); else value.close(); })
      .catch(reason => { if (active) { setError((reason as Error).message); setProcessing(false); } });
    return () => { active = false; decoded?.close(); URL.revokeObjectURL(url); };
  }, [file]);
  const moved = cropKey(crop) !== cropKey(settled), settledKey = cropKey(settled);
  useEffect(() => {
    if (!moved) return;
    const timer = setTimeout(() => setSettled(crop), ENCODE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [crop, moved]);
  useEffect(() => {
    if (!photo) return;
    let active = true, url: string | undefined; setProcessing(true); setError(''); setPrepared(null);
    void preparePhoto(photo, file, settled).then(value => {
      if (!active) return;
      url = URL.createObjectURL(value.file); setPrepared({ ...value, url });
    }).catch(reason => { if (active) setError((reason as Error).message); })
      .finally(() => { if (active) setProcessing(false); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [photo, file, settledKey]);
  function change(key: keyof PhotoCrop, percent: number) {
    setCrop(current => {
      const next = { ...current, [key]: percent / 100 };
      next.x = Math.min(next.x, 1 - next.width); next.y = Math.min(next.y, 1 - next.height);
      return next;
    });
  }
  return <section className="photo-preparation" aria-label="사진 자르기" aria-busy={processing || moved || busy}>
    {photo && <div className="photo-crop-source" style={{ aspectRatio: `${photo.width}/${photo.height}`, width: `${240 * photo.width / photo.height}px` }}>
      <img src={sourceUrl} alt="자르기 원본 사진" />
      <span style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} />
    </div>}
    <fieldset disabled={busy || !photo}><legend>사진 자르기</legend>
      {([['width', '너비', 10, 100], ['height', '높이', 10, 100], ['x', '왼쪽', 0, Math.round((1 - crop.width) * 100)], ['y', '위쪽', 0, Math.round((1 - crop.height) * 100)]] as const).map(([key, label, min, max]) =>
        <label key={key}>{label}<input aria-label={`사진 자르기 ${label}`} type="range" min={min} max={max} step={1} value={Math.round(crop[key] * 100)} onChange={event => change(key, Number(event.target.value))} /><output>{Math.round(crop[key] * 100)}%</output></label>)}
      <button type="button" onClick={() => setCrop({ ...FULL_PHOTO })}>전체 사진</button>
    </fieldset>
    {prepared && <div className="photo-prepared"><img src={prepared.url} alt="업로드할 사진" /><span>{prepared.width} × {prepared.height} · {Math.ceil(prepared.file.size / 1024)} KB</span></div>}
    {error && <p role="alert">{error}</p>}
    <div className="photo-preparation-actions"><button type="button" disabled={busy || processing || moved || !prepared} onClick={() => prepared && void onUpload(prepared.file)}>이 사진 사용</button><button type="button" disabled={busy} onClick={onCancel}>취소</button></div>
  </section>;
}
