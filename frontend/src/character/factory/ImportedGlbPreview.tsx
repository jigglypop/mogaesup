import { useEffect, useRef, useState } from 'react';
import { ModelViewer } from '../viewer';
import type { NativePartsState } from './api';

export function ImportedGlbPreview({ state }: { state: NativePartsState }) {
  const model = state.artifacts.find(item => item.name === 'model.glb');
  const mount = useRef<HTMLDivElement>(null), viewer = useRef<ModelViewer | null>(null);
  const [clips, setClips] = useState<{ name: string; index: number }[]>([]);
  const [ready, setReady] = useState(false), [error, setError] = useState('');
  const [motion, setMotion] = useState(-1), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!model || !mount.current) return;
    let active = true;
    setReady(false); setError(''); setClips([]); setMotion(-1);
    const instance = new ModelViewer(mount.current, 'studio');
    viewer.current = instance;
    void instance.load(model.url, { sha256: model.sha256 }).then(value => {
      if (!active) return;
      instance.play(-1); setClips(value); setReady(true);
    }).catch(reason => { if (active) setError((reason as Error).message); });
    return () => { active = false; instance.dispose(); viewer.current = null; };
  }, [model?.url, model?.sha256, attempt]);
  return <section className="meshy-motion assembly-preview">
    <h2>등록한 GLB</h2>
    <div className="meshy-scene" ref={mount} />
    {!ready && !error && <p role="status">GLB 불러오는 중…</p>}
    {error && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>다시 불러오기</button></p>}
    <div className="meshy-clips"><button disabled={!ready} aria-pressed={motion === -1} onClick={() => { viewer.current?.play(-1); setMotion(-1); }}>기본 자세</button>{clips.map(clip => <button key={clip.index} disabled={!ready} aria-pressed={motion === clip.index} onClick={() => { viewer.current?.play(clip.index); setMotion(clip.index); }}>{clip.name}</button>)}</div>
    {model && <a className="meshy-download" href={model.url} download>등록한 GLB 다운로드</a>}
  </section>;
}
