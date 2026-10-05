import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { Group } from 'three';
import { gltfAssetCache, useRendererRecovery } from 'gaesup-world';

import { layoutApi } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthProvider';
import { can } from '../../auth/can';
import { draftKey } from '../../auth/drafts';
import { createWorldRenderer } from '../../rendering/worldRenderer';
import { useFocusTrap } from '../../ui/focus';
import type { ResidentStore } from '../residents';
import { randomId } from '../stored';
import { SPAWN } from '../village';
import { modelBounds } from './bounds';
import { applyLayout, interpretLayout, measureLayoutCatalog, proposeLayout, type LayoutProposal } from './layout';
import type { EditSession } from './session';

/** A colour token from tokens.css, for the preview's materials the stylesheet cannot reach. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function PreviewModel({ url }: { url: string }) {
  const [scene, setScene] = useState<Group | null>(null);
  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    void gltfAssetCache.acquire(url).then(lease => {
      if (!active) { lease.release(); return; }
      release = lease.release; setScene(lease.gltf.scene.clone(true));
    }).catch(() => {});
    return () => { active = false; release?.(); };
  }, [url]);
  return scene ? <primitive object={scene} dispose={null} /> : null;
}

/** Points the camera at a new proposal's floor; the canvas and its renderer stay. */
function Framing({ cx, cz, distance }: { cx: number; cz: number; distance: number }) {
  const camera = useThree(state => state.camera);
  const invalidate = useThree(state => state.invalidate);
  useLayoutEffect(() => {
    camera.position.set(cx + distance, distance * 1.1, cz + distance);
    camera.lookAt(cx, 1.5, cz);
    invalidate();
  }, [camera, invalidate, cx, cz, distance]);
  return null;
}

/**
 * A separate canvas shows decoded models without touching the island store or its autosaver. Nothing in it moves on its
 * own, so it draws only when something changes: a model arriving, a resize, or the orbit controls (which ask for frames
 * while they turn and glide). One canvas serves every proposal made while the dialog is open.
 */
export function LayoutPreview({ proposal, stale = false }: { proposal: LayoutProposal; stale?: boolean }) {
  const { min, max, color } = proposal.floor;
  const cx = (min[0] + max[0]) / 2, cz = (min[1] + max[1]) / 2;
  const distance = Math.max(max[0] - min[0], max[1] - min[1]);
  const canvasKey = useRendererRecovery();
  const [colors] = useState(() => ({ sky: token('--mg-layout-sky'), path: token('--mg-layout-path') }));
  return <div className={`mg-layout-canvas${stale ? ' is-stale' : ''}`} role="img" aria-label="배치 미리보기">
    <Canvas key={canvasKey} gl={createWorldRenderer} dpr={[1, 1.5]} frameloop="demand" shadows camera={{ position: [cx + distance, distance * 1.1, cz + distance], fov: 42 }}>
      <Framing cx={cx} cz={cz} distance={distance} />
      {colors.sky && <color attach="background" args={[colors.sky]} />}
      <ambientLight intensity={1.5} />
      <directionalLight position={[cx + 12, 24, cz + 8]} intensity={2.5} />
      <mesh position={[cx, -.02, cz]} receiveShadow>
        <boxGeometry args={[max[0] - min[0], .04, max[1] - min[1]]} />
        <meshStandardMaterial color={color} roughness={.8} />
      </mesh>
      {proposal.walls.map(({ wall, center, alongX, color: wallColor }) => <group key={wall.id} position={[center[0], 0, center[1]]} rotation-y={alongX ? 0 : Math.PI / 2}>
        <mesh position-y={2}><boxGeometry args={[4, 4, .5]} /><meshStandardMaterial color={wallColor} /></mesh>
      </group>)}
      {proposal.objects.map(object => <group key={object.id} position={[object.position.x, object.position.y, object.position.z]}
        rotation-y={object.rotation ?? 0} scale={object.config?.modelScale ?? 1}>
        <PreviewModel url={object.config!.modelUrl!} />
      </group>)}
      <mesh position={[proposal.corridorX, .006, (proposal.corridor.minZ + proposal.corridor.maxZ) / 2]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[1.5, proposal.corridor.maxZ - proposal.corridor.minZ]} />
        <meshBasicMaterial color={colors.path || undefined} transparent opacity={.25} depthWrite={false} />
      </mesh>
      <OrbitControls target={[cx, 1.5, cz]} minDistance={4} maxDistance={distance * 3} maxPolarAngle={Math.PI * .48} />
    </Canvas>
  </div>;
}

/** Paid interpretations asked for, kept with the member's drafts (signing out clears them); the oldest go past this many. */
const MAX_RECEIPTS = 20;
type Receipt = { description: string; id: string };
const isReceipt = (value: unknown): value is Receipt =>
  typeof value === 'object' && value !== null && typeof (value as Receipt).description === 'string'
  && typeof (value as Receipt).id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test((value as Receipt).id);
const receiptsKey = (ownerId: string) => draftKey(ownerId, 'layout-interpretations');

/**
 * The request id for a paid interpretation of `description`: the one already asked under, or a new one written down
 * before the request goes, so a refresh or another preview of the same words replays the server's receipt instead of
 * paying again. Different owners cannot share it. Throws when the id cannot be kept.
 */
function receiptFor(ownerId: string, description: string): string {
  const key = receiptsKey(ownerId);
  let receipts: Receipt[] = [];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(saved)) receipts = saved.filter(isReceipt);
  } catch {
    // An unreadable record is replaced by the one written below.
  }
  const found = receipts.find(value => value.description === description);
  if (found) return found.id;
  const receipt = { description, id: randomId() };
  try { localStorage.setItem(key, JSON.stringify([...receipts, receipt].slice(-MAX_RECEIPTS))); }
  catch { throw new Error('AI 요청 기록을 저장하지 못했어요.'); }
  return receipt.id;
}

/**
 * The dialog over the island: the keyboard stays in it (the decorating shortcuts stand down while a modal is open) and
 * goes back to the button that opened it. While it works, focus that a disabled control would drop rests on the dialog.
 */
function Modal({ busy, initial, onClose, children }: { busy: boolean; initial: RefObject<HTMLElement | null>; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  useFocusTrap(dialog, initial);
  useEffect(() => {
    const node = dialog.current;
    if (busy && node && !node.contains(document.activeElement)) node.focus();
  }, [busy]);
  return createPortal(<div className="mg-layout-backdrop" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
  }}>
    <div ref={dialog} className="mg-layout-dialog mg-glass" role="dialog" aria-modal="true" aria-labelledby="mg-layout-title" aria-busy={busy} tabIndex={-1}>
      {children}
    </div>
  </div>, document.body);
}

type Props = { session: EditSession; residents: ResidentStore; ownerId: string };
type Preview = { proposal: LayoutProposal; residentsRevision: number };
export function LayoutComposer({ session, residents, ownerId }: Props) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [ai, setAi] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const [working, setWorking] = useState<'interpreting' | 'measuring' | null>(null);
  const [error, setError] = useState('');
  // The last proposal stays in the canvas while the next is made or the description changes; `fresh` says it is the
  // proposal for what is entered now, and only then can it be applied.
  const [preview, setPreview] = useState<Preview | null>(null);
  const [fresh, setFresh] = useState(false);
  const request = useRef<AbortController | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const busy = working !== null;
  const allowed = user?.id === ownerId;
  const paid = can(user, 'paid_operator');
  useEffect(() => {
    setAiReady(false); setAi(false);
    if (!paid || !allowed) return;
    const controller = new AbortController();
    void layoutApi.capabilities(controller.signal).then(value => {
      if (!controller.signal.aborted) setAiReady(value.ai);
    }).catch(() => {});
    return () => controller.abort();
  }, [paid, allowed, ownerId]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (allowed) return;
    request.current?.abort(); request.current = null;
    setWorking(null); setPreview(null); setFresh(false);
  }, [allowed]);
  const changed = () => setFresh(false);
  const close = () => {
    request.current?.abort(); request.current = null;
    setOpen(false); setWorking(null); setPreview(null); setFresh(false);
  };
  const create = async () => {
    const text = description.trim();
    if (busy || !allowed || !text) return;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setError(''); setFresh(false);
    try {
      let intent;
      if (ai && paid && aiReady) {
        setWorking('interpreting');
        intent = await layoutApi.interpret({ description: text, mode: 'ai', requestId: receiptFor(ownerId, text) }, controller.signal);
      } else intent = interpretLayout(text);
      if (controller.signal.aborted) return;
      setWorking('measuring');
      const snapshot = session.runtime.buildingStore.getState().serialize();
      const residentRevision = residents.revision();
      const measured = await measureLayoutCatalog(snapshot.objects.flatMap(object => object.config?.modelUrl ? [object.config.modelUrl] : []));
      if (controller.signal.aborted) return;
      const pivot = session.pivot();
      const points = residents.getState().map(resident => [resident.position[0], resident.position[2]] as const);
      const proposal = proposeLayout(snapshot, intent, measured, [pivot.x, pivot.z], [...points, [SPAWN[0], SPAWN[2]]], modelBounds);
      setPreview({ proposal, residentsRevision: residentRevision });
      setFresh(true);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '배치를 만들지 못했어요.');
    } finally { if (request.current === controller) { request.current = null; setWorking(null); } }
  };
  const apply = () => {
    if (!preview || !fresh || busy || !allowed) return;
    try {
      if (residents.revision() !== preview.residentsRevision) throw new Error('주민 위치가 바뀌었어요. 배치를 다시 만들어 주세요.');
      applyLayout(session, preview.proposal); close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '배치를 적용하지 못했어요.'); }
  };
  return <>
    <button className="mg-btn is-small" disabled={!allowed} onClick={() => { setOpen(true); setError(''); }}>매장 배치</button>
    {open && <Modal busy={busy} initial={field} onClose={close}>
      <header><h2 id="mg-layout-title">매장 배치</h2><button className="mg-btn is-small" onClick={close}>닫기</button></header>
      <label>공간 설명<textarea ref={field} value={description} maxLength={2000} readOnly={busy} onChange={event => { setDescription(event.target.value); changed(); }} /></label>
      <div className="mg-row">
        {paid && aiReady && <label className="mg-layout-ai"><input type="checkbox" checked={ai} disabled={busy} onChange={event => { setAi(event.target.checked); changed(); }} />AI 해석 (유료)</label>}
        <button className="mg-btn" disabled={!busy && (!description.trim() || !allowed)} aria-disabled={busy || undefined} onClick={() => void create()}>
          {working === 'interpreting' ? 'AI 해석 중…' : working === 'measuring' ? '크기 확인 중…' : '배치 만들기'}
        </button>
      </div>
      {error && <p role="alert" className="mg-error">{error}</p>}
      {preview && <>
        <p className="mg-layout-result">{({ cafe: '카페', shop: '매장', office: '사무실' } as const)[preview.proposal.intent.kind]} · {preview.proposal.intent.widthCells * 4}m × {preview.proposal.intent.depthCells * 4}m · 기물 {preview.proposal.objects.length}개 · 좌석 {preview.proposal.intent.seats}개</p>
        <LayoutPreview proposal={preview.proposal} stale={!fresh} />
        {fresh && preview.proposal.notice.map(text => <p key={text} role="status">{text}</p>)}
        <button className="mg-btn" disabled={!allowed || busy || !fresh} onClick={apply}>섬에 적용</button>
      </>}
    </Modal>}
  </>;
}
