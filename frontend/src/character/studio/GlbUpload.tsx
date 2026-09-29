import { useId, useRef, useState } from 'react';
import './glb-upload.css';

export function GlbUpload({ disabled = false, onUpload, maxMb = 64 }: { disabled?: boolean; onUpload: (file: File) => Promise<void>; maxMb?: number }) {
  const id = useId(), locked = useRef(false), dragDepth = useRef(0);
  const [file, setFile] = useState<File>(), [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false), [complete, setComplete] = useState(false), [error, setError] = useState('');
  const unavailable = disabled || uploading;
  function select(files: File[]) {
    if (disabled || locked.current) return;
    setError(''); setComplete(false);
    if (!files.length) return;
    const next = files[0];
    const problem = files.length !== 1 ? 'GLB 파일을 하나만 선택해 주세요.'
      : !/\.glb$/i.test(next.name) ? '.glb 파일을 선택해 주세요.'
      : next.size === 0 ? '빈 파일은 등록할 수 없습니다.'
      : next.size > maxMb * 1024 * 1024 ? `GLB는 ${maxMb}MB 이내로 올려 주세요.` : '';
    if (problem) { setFile(undefined); setError(problem); return; }
    setFile(next);
  }
  async function upload() {
    if (!file || disabled || locked.current) return;
    locked.current = true; setUploading(true); setError('');
    try { await onUpload(file); setComplete(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'GLB 등록에 실패했습니다.'); }
    finally { locked.current = false; setUploading(false); }
  }
  return <div className="glb-upload" tabIndex={unavailable ? -1 : 0} aria-label="GLB 파일 선택, 드래그 또는 붙여넣기" data-dragging={dragging && !unavailable} data-disabled={unavailable} aria-busy={uploading}
    onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); select(files); } }}
    onDragEnter={event => { event.preventDefault(); if (!unavailable) { dragDepth.current++; setDragging(true); } }}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = unavailable ? 'none' : 'copy'; }}
    onDragLeave={event => { event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); select(Array.from(event.dataTransfer.files)); }}>
    <label className="glb-upload-dropzone" htmlFor={id}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 0v9m-9-4 9 5 9-5m-9 5v9" /></svg>
      <span className="glb-upload-caption"><strong>GLB 등록</strong><span id={`${id}-hint`}>파일 선택 · 드래그 · 붙여넣기 · 최대 {maxMb}MB</span></span>
      <span className="glb-upload-choose">{file ? '파일 변경' : '파일 선택'}</span>
      <input id={id} className="glb-upload-input" type="file" accept=".glb,model/gltf-binary" disabled={unavailable}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} aria-invalid={!!error}
        onChange={event => { select(Array.from(event.target.files || [])); event.target.value = ''; }} />
    </label>
    {file && <div className="glb-upload-selection"><div><strong title={file.name}>{file.name}</strong><small>{file.size >= 1048576 ? `${(file.size / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.ceil(file.size / 1024))} KB`}</small></div><button type="button" disabled={unavailable || complete} onClick={() => void upload()}>{uploading ? '등록 중…' : complete ? '등록 완료' : '등록'}</button></div>}
    {uploading && <progress aria-label="GLB 등록 중" />}
    {complete && <span className="glb-upload-status" role="status">등록 완료</span>}
    {error && <p id={`${id}-error`} role="alert">{error}</p>}
  </div>;
}
