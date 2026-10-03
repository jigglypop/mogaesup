import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { Group } from 'three';
import { gltfAssetCache } from 'gaesup-world';

import { layoutApi } from '../../api/endpoints';
import type { CatalogItem } from '../../api/types';
import { useAuth } from '../../auth/AuthProvider';
import { can } from '../../auth/can';
import { createWorldRenderer } from '../../rendering/worldRenderer';
import type { ResidentStore } from '../residents';
import { SPAWN } from '../village';
import { modelBounds } from './bounds';
import { applyLayout, interpretLayout, measureLayoutCatalog, proposeLayout, type LayoutProposal } from './layout';
import type { EditSession } from './session';

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

/** A separate canvas shows decoded models without touching the island store or its autosaver. */
export function LayoutPreview({ proposal }: { proposal: LayoutProposal }) {
  const { min, max, color } = proposal.floor;
  const cx = (min[0] + max[0]) / 2, cz = (min[1] + max[1]) / 2;
  const distance = Math.max(max[0] - min[0], max[1] - min[1]);
  return <div className="mg-layout-canvas" aria-label="배치 미리보기">
    <Canvas gl={createWorldRenderer} shadows camera={{ position: [cx + distance, distance * 1.1, cz + distance], fov: 42 }}>
      <color attach="background" args={['#cde4e8']} />
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
        <meshBasicMaterial color="#52bba4" transparent opacity={.25} depthWrite={false} />
      </mesh>
      <OrbitControls target={[cx, 1.5, cz]} minDistance={4} maxDistance={distance * 3} maxPolarAngle={Math.PI * .48} />
    </Canvas>
  </div>;
}

type Props = { session: EditSession; residents: ResidentStore; studioItems: CatalogItem[]; ownerId: string };
export function LayoutComposer({ session, residents, studioItems, ownerId }: Props) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('12m × 12m 카페, 나무 바닥, 2인 좌석');
  const [ai, setAi] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ proposal: LayoutProposal; residentsRevision: number } | null>(null);
  const request = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
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
    if (!open) return;
    dialog.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, [open]);
  useEffect(() => {
    if (!allowed) { request.current?.abort(); setPreview(null); }
  }, [allowed]);
  const close = () => { request.current?.abort(); setOpen(false); setBusy(false); opener.current?.focus(); };
  const create = async () => {
    if (busy || !allowed) return;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setBusy(true); setError(''); setPreview(null);
    try {
      let intent;
      if (ai && paid && aiReady) {
        // Persist before POST. Refreshing or making another preview of the same description replays the
        // server receipt instead of authorizing a second paid request. Different owners cannot share it.
        const storage = `mogaesup:layout-interpretations:${ownerId}`;
        let receipts: { description: string; id: string }[] = [];
        try {
          const saved: unknown = JSON.parse(localStorage.getItem(storage) ?? '[]');
          if (Array.isArray(saved)) receipts = saved.filter((value): value is { description: string; id: string } =>
            value && typeof value.description === 'string' && typeof value.id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value.id));
        } catch { throw new Error('AI 요청 기록을 읽지 못했어요. 브라우저 저장 공간을 확인해 주세요.'); }
        let receipt = receipts.find(value => value.description === description.trim());
        if (!receipt) {
          receipt = { description: description.trim(), id: crypto.randomUUID() };
          receipts.push(receipt);
          try { localStorage.setItem(storage, JSON.stringify(receipts)); }
          catch { throw new Error('AI 요청 기록을 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.'); }
        }
        intent = await layoutApi.interpret({ description, mode: 'ai', requestId: receipt.id }, controller.signal);
      } else intent = interpretLayout(description);
      const snapshot = session.runtime.buildingStore.getState().serialize();
      const residentRevision = residents.revision();
      const measured = await measureLayoutCatalog(studioItems, snapshot.objects.flatMap(object => object.config?.modelUrl ? [object.config.modelUrl] : []));
      if (controller.signal.aborted) return;
      const pivot = session.pivot();
      const points = residents.getState().map(resident => [resident.position[0], resident.position[2]] as const);
      const proposal = proposeLayout(snapshot, intent, measured, [pivot.x, pivot.z], [...points, [SPAWN[0], SPAWN[2]]], modelBounds);
      setPreview({ proposal, residentsRevision: residentRevision });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '배치를 만들지 못했어요. 다시 시도해 주세요.');
    } finally { if (request.current === controller && !controller.signal.aborted) setBusy(false); }
  };
  const apply = () => {
    if (!preview || !allowed) return;
    try {
      if (residents.revision() !== preview.residentsRevision) throw new Error('주민 위치가 바뀌었어요. 배치를 다시 만들어 주세요.');
      applyLayout(session, preview.proposal); setPreview(null); close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '배치를 적용하지 못했어요.'); }
  };
  return <>
    <button ref={opener} className="mg-btn is-small" disabled={!allowed} onClick={() => { setOpen(true); setError(''); }}>매장 배치</button>
    {open && createPortal(<div className="mg-layout-backdrop" onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, input:not(:disabled)') ?? [])];
        const first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div ref={dialog} className="mg-layout-dialog mg-glass" role="dialog" aria-modal="true" aria-labelledby="mg-layout-title">
        <header><h2 id="mg-layout-title">매장 배치</h2><button className="mg-btn is-small" onClick={close}>닫기</button></header>
        <label>공간 설명<textarea value={description} maxLength={2000} disabled={busy} onChange={event => { setDescription(event.target.value); setPreview(null); }} /></label>
        <div className="mg-row">
          {paid && aiReady && <label className="mg-layout-ai"><input type="checkbox" checked={ai} disabled={busy} onChange={event => { setAi(event.target.checked); setPreview(null); }} />AI 해석 (유료)</label>}
          <button className="mg-btn" disabled={busy || !description.trim() || !allowed} onClick={() => void create()}>{busy ? '크기 확인 중…' : '배치 만들기'}</button>
        </div>
        {error && <p role="alert" className="mg-error">{error}</p>}
        {preview && <>
          <p className="mg-layout-result">{({ cafe: '카페', shop: '매장', office: '사무실' } as const)[preview.proposal.intent.kind]} · {preview.proposal.intent.widthCells * 4}m × {preview.proposal.intent.depthCells * 4}m · 기물 {preview.proposal.objects.length}개 · 좌석 {preview.proposal.intent.seats}개</p>
          <LayoutPreview proposal={preview.proposal} />
          {preview.proposal.notice.map(text => <p key={text} role="status">{text}</p>)}
          <button className="mg-btn" disabled={!allowed || busy} onClick={apply}>섬에 적용</button>
        </>}
      </div>
    </div>, document.body)}
  </>;
}
