import { useEffect, useRef, useState } from 'react';
import { request } from '../api';
import type { AssetPreviewModel } from './AssetModelPreview';

type Stats = { triangles: number; vertices: number; meshes: number; materials: number; bones: number;
  texture_images: number; animations: number; file_bytes: number; expected_sha256: string };
const cache = new Map<string, Stats>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
function drain() {
  while (running < 3 && queue.length) {
    const next = queue.shift()!;
    running++;
    void next().finally(() => { running--; drain(); });
  }
}
function endpoint(url: string) {
  const match = url.match(/^\/api\/avatar-factory\/jobs\/([a-f0-9]{24})\/(?:artifacts\/([^/?]+)|native-parts\/([a-f0-9]{24})\/([^/?]+))(?:\?.*)?$/);
  if (!match) return undefined;
  const query = new URLSearchParams({ name: match[2] || match[4] });
  if (match[3]) query.set('version', match[3]);
  return `/api/avatar-factory/jobs/${match[1]}/model-stats?${query}`;
}
function read(url: string, key: string, sha: string | undefined, signal: AbortSignal) {
  return new Promise<Stats>((resolve, reject) => {
    queue.push(async () => {
      try {
        signal.throwIfAborted();
        const result = cache.get(key) || await request<Stats>(url, { signal, timeoutMs: 30000 });
        if (sha && result.expected_sha256 !== sha) throw new Error('모델이 변경되었습니다. 목록을 새로 불러와 주세요.');
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(key, result);
        resolve(result);
      } catch (error) { reject(error); }
    });
    drain();
  });
}

export function AssetModelStats({ model, detail = false }: { model?: AssetPreviewModel; detail?: boolean }) {
  const mount = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [value, setValue] = useState<{ key: string; stats: Stats }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const url = model && endpoint(model.url);
  const key = `${model?.url}:${model?.sha256 || ''}`;
  const stats = value?.key === key ? value.stats : cache.get(key);
  useEffect(() => {
    if (!mount.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '100px' });
    observer.observe(mount.current);
    return () => observer.disconnect();
  }, [url]);
  useEffect(() => {
    setError('');
    if (!visible || !url) return;
    const controller = new AbortController();
    void read(url, key, model?.sha256, controller.signal).then(result => {
      if (!controller.signal.aborted) setValue({ key, stats: result });
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); });
    return () => controller.abort();
  }, [url, key, visible, attempt]);
  if (!url) return null;
  const number = (value: number) => value.toLocaleString();
  return <div ref={mount} className={`asset-model-stats ${detail ? 'detail' : ''}`} aria-label={`${model?.label} 모델 정보`}>
    {stats ? <><div className="asset-model-stats-heading"><span>{model?.label}</span><strong>{(stats.file_bytes / 1000000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB</strong></div>
      <dl><div><dt>폴리곤 · 삼각형</dt><dd>{number(stats.triangles)}</dd></div><div><dt>정점</dt><dd>{number(stats.vertices)}</dd></div>
      {detail && <><div><dt>메시</dt><dd>{number(stats.meshes)}</dd></div><div><dt>재질</dt><dd>{number(stats.materials)}</dd></div><div><dt>텍스처 이미지</dt><dd>{number(stats.texture_images)}</dd></div><div><dt>본</dt><dd>{number(stats.bones)}</dd></div><div><dt>애니메이션</dt><dd>{number(stats.animations)}</dd></div></>}</dl></>
      : error ? <div className="asset-stats-error"><span title={error}>모델 정보 조회 실패</span><button type="button" onClick={() => setAttempt(value => value + 1)}>다시 조회</button></div>
        : <span className="asset-stats-loading">폴리곤 수 확인 중…</span>}
  </div>;
}
