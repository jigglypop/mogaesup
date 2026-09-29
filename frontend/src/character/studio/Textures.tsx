import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePolling } from '../use-polling';
import { studioApi, type Tile } from './api';
import type { TileShape } from './TilePreview';
import './textures.css';

const TilePreview = lazy(() => import('./TilePreview'));

const surfaces: Record<string, string> = {
  snow: '눈', sand: '모래', grass: '잔디', soil: '흙', stone: '돌',
  wood: '나뭇결', bark: '나무껍질', brick: '벽돌',
};

export default function Textures({ extra }: { extra?: ReactNode }) {
  const listing = usePolling(studioApi.textures, 15000);
  const [surface, setSurface] = useState('snow');
  const [size, setSize] = useState(512);
  const [seed, setSeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [shape, setShape] = useState<TileShape>('plane');
  const [repeat, setRepeat] = useState(3);
  const [autoOrbit, setAutoOrbit] = useState(false);
  const locked = useRef(false);
  const items = listing.value?.items || [];
  const selected = items.find(tile => tile.id === selectedId) || items[0];

  useEffect(() => {
    if (items.length && !items.some(tile => tile.id === selectedId)) setSelectedId(items[0].id);
  }, [items, selectedId]);

  const generate = (event: React.FormEvent) => {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    void studioApi.texture({ surface, size, seed }).then(result => {
      listing.setValue(current => ({ items: [result, ...(current?.items || []).filter(tile => tile.id !== result.id)] }));
      setSelectedId(result.id);
    }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => { locked.current = false; setBusy(false); });
  };

  return <div className="workspace-content texture-workspace">
    <h1>기본 바닥 타일</h1>
    <form className="texture-form" onSubmit={generate}>
      <label>표면<select disabled={busy} value={surface} onChange={event => setSurface(event.target.value)}>
        {Object.entries(surfaces).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>해상도<select disabled={busy} value={size} onChange={event => setSize(Number(event.target.value))}>
        {[256, 512, 1024].map(value => <option key={value} value={value}>{value} × {value}</option>)}
      </select></label>
      <label>시드<input disabled={busy} type="number" min={0} max={2147483647} value={seed}
        onChange={event => setSeed(Number(event.target.value))} /></label>
      <button disabled={busy}>{busy ? '생성 중' : '타일 생성'}</button>
    </form>
    {extra}
    {(error || listing.error) && <p className="workspace-error" role="alert">{error || listing.error}</p>}
    {selected && <section className="management-panel tile-inspector" aria-label="선택한 타일 3D 미리보기">
      <div className="tile-preview-heading"><div><h2>{surfaces[selected.surface] || selected.surface}</h2><small>{selected.size}px · 시드 {selected.seed}</small></div>
        <div className="tile-preview-settings">
          <label>형태<select value={shape} onChange={event => setShape(event.target.value as TileShape)}>
            <option value="plane">평면</option><option value="cube">큐브</option><option value="sphere">구</option>
          </select></label>
          <label>반복<input type="number" min={1} max={12} step={1} value={repeat}
            onChange={event => setRepeat(Math.max(1, Math.min(12, Number(event.target.value) || 1)))} /></label>
          <label className="tile-check"><input type="checkbox" checked={autoOrbit} onChange={event => setAutoOrbit(event.target.checked)} /> 자동 회전</label>
        </div>
      </div>
      <Suspense fallback={<div className="tile-preview-gate">3D 미리보기 준비 중</div>}>
        <TilePreview tile={selected} shape={shape} repeat={repeat} autoOrbit={autoOrbit} />
      </Suspense>
    </section>}
    <div className="asset-grid tile-grid">{items.map((tile: Tile) => {
      const albedo = tile.artifacts.find(item => item.name === 'albedo.webp')?.url;
      return <article className={`asset-card${tile.id === selected?.id ? ' selected' : ''}`} key={tile.id}>
        <button className="tile-select" type="button" aria-pressed={tile.id === selected?.id} onClick={() => setSelectedId(tile.id)}>
          <span className="tile-preview" style={{ backgroundImage: albedo ? `url(${albedo})` : undefined }} />
          <strong>{surfaces[tile.surface] || tile.surface} · {tile.size}px · {tile.seed}</strong>
          <small>GPU {(tile.gpu.estimated_bytes_with_mips / 1048576).toFixed(1)} MiB</small>
        </button>
        <div className="artifact-grid">{tile.artifacts.map(item => <a key={item.name} href={item.url} download>{item.name}</a>)}</div>
      </article>;
    })}</div>
  </div>;
}
