import { useEffect, useMemo, useRef, useState } from 'react';
import type { CardView } from '../viewer';
import { AssetModelStats } from './AssetModelStats';
import { claimViewer, type ViewerClaim } from './live-viewers';
import './asset-model-preview.css';

export type AssetPreviewModel = { url: string; sha256?: string; label: string; name?: string };
type AssetModelPreviewProps = {
  model?: AssetPreviewModel;
  models?: AssetPreviewModel[];
  image?: { url: string };
  name: string;
  emptyLabel: string;
  detail?: boolean;
  autoLoad?: boolean;
  /** Play an animation clip while the preview is pointed at or holds focus: this clip name when present, otherwise the first. */
  animate?: boolean;
  clip?: string;
};

type View = 'model' | 'image';

const modelIdentity = (model: AssetPreviewModel) => `${model.url}:${model.sha256 ?? ''}`;
/** How long a card whose viewer is taken back waits for the frame it keeps as its still picture. */
const STILL_MS = 1000;

/** `work`, or a failure once `ms` have passed without it. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export function AssetModelPreview({ model, models, image, name, emptyLabel, detail = false, autoLoad = detail, animate = false, clip }: AssetModelPreviewProps) {
  const viewerMount = useRef<HTMLDivElement>(null);
  const viewer = useRef<import('../viewer').ModelViewer | null>(null);
  const nameRef = useRef(name);
  nameRef.current = name;
  const choices = useMemo(() => models?.length ? models : model ? [model] : [], [model, models]);
  const choicesKey = choices.map(modelIdentity).join('|');
  const [selectedModel, setSelectedModel] = useState(() => choices[0] ? modelIdentity(choices[0]) : '');
  const activeModel = choices.find(item => modelIdentity(item) === selectedModel) || choices[0];
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Whether the card holds a viewer: granted by the budget all cards share (see live-viewers) while it wants to show its
  // model, and taken back when it has been off screen too long or a card used more recently needs it. Off screen it
  // stops drawing.
  const [live, setLive] = useState(false);
  const claim = useRef<ViewerClaim | null>(null);
  // The model as this card last drew it, or as the shared thumbnail viewer drew it: shown while it holds no viewer.
  const [still, setStill] = useState('');
  // A gallery card plays its clip only while pointed at or focused; moving cards would each draw every frame. Pointing at
  // or focusing a card also asks for a viewer.
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const engaged = hovered || focused, engagedRef = useRef(engaged);
  engagedRef.current = engaged;
  const clipIndex = useRef(-1);
  const [view, setView] = useState<View>(activeModel && autoLoad ? 'model' : 'image');
  const [cardView, setCardView] = useState<CardView>('front');
  const [wireframe, setWireframe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const modelUrl = activeModel?.url;
  const hasModel = Boolean(modelUrl);
  const modelSha256 = activeModel?.sha256;
  const modelLabel = activeModel?.label;
  const modelKey = useMemo(() => modelUrl ? `${modelUrl}:${modelSha256 ?? ''}` : '', [modelSha256, modelUrl]);
  // A card whose model failed to load or draw holds no viewer: it gives its place back, and '다시 시도' asks again.
  const wantsViewer = hasModel && view === 'model' && !error;

  useEffect(() => {
    setSelectedModel(current => choices.some(item => modelIdentity(item) === current) ? current : choices[0] ? modelIdentity(choices[0]) : '');
  }, [choicesKey]);

  useEffect(() => {
    const element = viewerMount.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { threshold: 0.01 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setView(hasModel && autoLoad ? 'model' : 'image');
  }, [hasModel, autoLoad]);

  useEffect(() => {
    setLoading(false);
    setReady(false);
    setError('');
    setAttempt(0);
    setStill('');
  }, [modelKey]);

  useEffect(() => {
    if (!wantsViewer) return;
    // Grants so far: a viewer granted back while its picture was being taken stays where it is.
    let active = true, grants = 0;
    // Taken back: keep a picture of what the viewer shows, then let it go. A hidden page draws no frame to keep, so
    // there it goes at once, as it does when no frame comes in time.
    const retire = async () => {
      const granted = grants, instance = viewer.current;
      if (instance && readyRef.current && !document.hidden) {
        try {
          const picture = await within(instance.snapshot(), STILL_MS);
          if (viewer.current === instance) setStill(picture.src);
        } catch { /* The viewer closed first or drew no frame: the card shows its image or placeholder. */ }
      }
      if (active && grants === granted) setLive(false);
    };
    const mine = claimViewer({ pinned: detail, visible: visibleRef.current, grant: () => { grants++; setLive(true); }, revoke: () => void retire() });
    claim.current = mine;
    // Opened by a click on the card ("3D 보기"): it is the card in use.
    if (engagedRef.current) mine.touch();
    return () => { active = false; mine.release(); if (claim.current === mine) claim.current = null; setLive(false); };
  }, [wantsViewer, detail, modelKey]);
  useEffect(() => { claim.current?.show(visible); }, [visible]);

  useEffect(() => {
    const element = viewerMount.current;
    if (!element || !modelUrl || view !== 'model' || !live) return;
    let active = true;
    let instance: import('../viewer').ModelViewer | undefined;
    const fail = (reason: unknown) => {
      if (!active) return;
      instance?.dispose();
      instance = undefined;
      viewer.current = null;
      setLoading(false);
      setReady(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    };
    setLoading(true);
    setReady(false);
    setError('');
    void import('../viewer').then(({ ModelViewer }) => {
      if (!active) return;
      // A renderer that fails after the model is shown (its device lost for good) ends up where a failed load does.
      instance = new ModelViewer(element, 'card', { onFailure: fail });
      viewer.current = instance;
      const canvas = element.querySelector('canvas');
      canvas?.setAttribute('aria-label', `${nameRef.current} 3D 모델`);
      // The viewer gives up when the server stops answering or the file stops arriving, never for a large file.
      return instance.load(modelUrl, { sha256: modelSha256 });
    }).then(clips => {
      if (!active) return;
      clipIndex.current = animate && clips?.length ? Math.max(0, clips.findIndex(item => item.name === clip)) : -1;
      setReady(true);
      setLoading(false);
    }).catch(fail);
    return () => {
      active = false;
      instance?.dispose();
      if (viewer.current === instance) viewer.current = null;
      setReady(false); setLoading(false);
    };
  }, [animate, attempt, clip, modelKey, modelSha256, modelUrl, view, live]);

  useEffect(() => { if (engaged) claim.current?.touch(); }, [engaged]);
  useEffect(() => {
    if (ready && clipIndex.current >= 0) viewer.current?.play(engaged ? clipIndex.current : -1);
  }, [engaged, ready]);
  useEffect(() => { viewer.current?.setCardView(cardView); }, [cardView, ready]);
  useEffect(() => { if (ready) viewer.current?.setWireframe(wireframe); }, [wireframe, ready]);
  // A card waiting for a viewer with no picture of its own gets one drawn by the shared thumbnail viewer (one renderer
  // for every card).
  useEffect(() => {
    if (!wantsViewer || live || still || image || !visible || !modelUrl) return;
    const controller = new AbortController();
    void import('../part-thumbnails')
      .then(({ canDrawThumbnails, partThumbnail }) => canDrawThumbnails() ? partThumbnail(modelUrl, modelSha256 ?? '', controller.signal) : null)
      .then(picture => { if (picture && !controller.signal.aborted) setStill(picture.src); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [wantsViewer, live, still, image, visible, modelUrl, modelSha256]);

  useEffect(() => {
    viewerMount.current?.querySelector('canvas')?.setAttribute('aria-label', `${name} 3D 모델`);
  }, [name, ready]);

  const shownStill = view === 'model' && !ready && !error ? still : '';
  const showImage = Boolean(image) && !shownStill && (view === 'image' || !ready);
  const source = view === 'image' ? (image ? '이미지' : undefined)
    : error ? image ? '3D 로드 실패 · 2D 이미지' : '3D 로드 실패'
      : shownStill ? modelLabel
        : !ready ? !live ? image ? '2D 이미지' : undefined
          : image ? '3D 불러오는 중 · 2D 이미지' : modelUrl ? '3D 불러오는 중' : undefined
          : modelLabel;

  return <div className="asset-model-preview-group"><div className={`asset-model-preview ${detail ? 'detail' : ''}`} aria-busy={loading}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {shownStill && <img src={shownStill} alt={`${name} 3D 모델`} />}
    {showImage && <img src={image!.url} alt={`${name} 2D 이미지`} loading="lazy" />}
    {!image && !shownStill && (view === 'image' || !activeModel || !visible || !live || loading || error) && <div className="asset-model-preview-empty">{activeModel ? view === 'image' ? '저장된 3D' : loading ? '3D 불러오는 중' : error ? '3D 미리보기 오류' : '3D 미리보기 준비 중' : emptyLabel}</div>}
    <div className="asset-model-preview-canvas" ref={viewerMount} />
    {source && <span className="asset-model-preview-source">{source}</span>}
    {modelUrl && <button type="button" className="asset-model-preview-toggle" aria-pressed={view === 'model'} onClick={() => { setLoading(false); setReady(false); setView(current => current === 'model' ? 'image' : 'model'); }}>{view === 'model' ? '3D 닫기' : '3D 보기'}</button>}
    {detail && view === 'model' && <button type="button" className="asset-model-wireframe" disabled={!ready} aria-pressed={wireframe} onClick={() => setWireframe(value => !value)}>와이어프레임</button>}
    {detail && choices.length > 1 && <label className="asset-model-preview-models"><span>3D 파일</span><select aria-label="3D 파일 선택" value={activeModel ? modelIdentity(activeModel) : ''} onChange={event => { setSelectedModel(event.target.value); setView('model'); }}>{choices.map(item => <option key={modelIdentity(item)} value={modelIdentity(item)}>{item.name || item.label}</option>)}</select></label>}
    {detail && modelUrl && view === 'model' && <div className="asset-model-preview-views" role="group" aria-label="카메라 방향">{([['front','정면'],['side','좌측'],['back','후면'],['opposite','우측']] as const).map(([key,label]) => <button type="button" key={key} aria-pressed={cardView === key} onClick={() => setCardView(key)}>{label}</button>)}</div>}
    {error && view === 'model' && <div className="asset-model-preview-error" role="alert"><span>3D 미리보기 로드 실패</span><small>{error}</small><button type="button" onClick={() => { setError(''); setAttempt(value => value + 1); }}>다시 시도</button></div>}
  </div><AssetModelStats model={activeModel} detail={detail} /></div>;
}
