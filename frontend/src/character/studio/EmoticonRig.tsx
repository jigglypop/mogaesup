import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { generationsApi, type Generation, type Joint, type MotionFormat, type MotionInput, type MotionTemplate } from './generations-api';

const jointLabels: Record<string, string> = {
  head_top: '정수리', neck: '목', pelvis: '골반', shoulder_r: '오른어깨', elbow_r: '오른팔꿈치', wrist_r: '오른손목',
  shoulder_l: '왼어깨', elbow_l: '왼팔꿈치', wrist_l: '왼손목', hip_r: '오른엉덩이', knee_r: '오른무릎', ankle_r: '오른발목',
  hip_l: '왼엉덩이', knee_l: '왼무릎', ankle_l: '왼발목',
};
const links: [string, string][] = [['pelvis', 'neck'], ['neck', 'head_top'], ['neck', 'shoulder_r'], ['shoulder_r', 'elbow_r'], ['elbow_r', 'wrist_r'],
  ['neck', 'shoulder_l'], ['shoulder_l', 'elbow_l'], ['elbow_l', 'wrist_l'], ['pelvis', 'hip_r'], ['hip_r', 'knee_r'], ['knee_r', 'ankle_r'],
  ['pelvis', 'hip_l'], ['hip_l', 'knee_l'], ['knee_l', 'ankle_l']];
const templates: [MotionTemplate, string][] = [['idle', '대기'], ['wave', '인사'], ['jump', '점프'], ['nod', '끄덕'], ['shake', '도리도리'], ['sway', '흔들기']];
const formats: [MotionFormat, string][] = [['gif', 'GIF'], ['webp', 'WebP'], ['apng', 'APNG']];
const templateLabel = Object.fromEntries(templates) as Record<MotionTemplate, string>;
const versioned = (artifact: { url: string; sha256: string }) => `${artifact.url}?v=${artifact.sha256.slice(0, 12)}`;
const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()}KB`;

type Props = { generation: Generation; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; onChange: (generation: Generation) => void };

export function EmoticonRig({ generation, busy, perform, onChange }: Props) {
  const rig = generation.rig;
  const [joints, setJoints] = useState<Record<string, Joint>>(rig?.joints || {});
  const [view, setView] = useState<'image' | 'regions'>('image');
  const [input, setInput] = useState<MotionInput>({ template: 'wave', strength: 1, speed: 1, fps: 15, size: 360 });
  const [working, setWorking] = useState<'' | 'rig' | 'motion'>('');
  const svg = useRef<SVGSVGElement>(null), dragging = useRef('');
  useEffect(() => { setJoints(rig?.joints || {}); }, [rig?.sha256]);
  const artifact = (name: string) => generation.artifacts.find(item => item.name === name);
  const image = artifact('image.png'), regions = artifact('rig-regions.png');
  const dirty = !!rig && JSON.stringify(joints) !== JSON.stringify(rig.joints);
  const radius = rig ? rig.width / 110 : 0;
  const motions = Object.values(generation.motions || {}).filter(Boolean).sort((a, b) => b!.created_at.localeCompare(a!.created_at));

  async function run(kind: 'rig' | 'motion', action: () => Promise<Generation>) {
    await perform(async () => {
      setWorking(kind);
      try { onChange(await action()); } finally { setWorking(''); }
    });
  }
  function point(event: PointerEvent<SVGElement>): Joint | null {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return null;
    const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return [Math.round(at.x * 10) / 10, Math.round(at.y * 10) / 10];
  }
  function move(name: string, next: Joint) { setJoints(current => ({ ...current, [name]: next })); }
  function nudge(name: string, event: KeyboardEvent<SVGCircleElement>) {
    const step = event.shiftKey ? 10 : 2, delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta || busy) return;
    event.preventDefault();
    move(name, [joints[name][0] + delta[0], joints[name][1] + delta[1]]);
  }

  return <section className="generation-result emoticon-rig" aria-label="리깅과 모션">
    <div className="generation-result-heading"><h2>리깅</h2>
      {rig && <small>관절 {Object.keys(rig.joints).length} · 삼각형 {rig.triangles.toLocaleString()} · {rig.adjusted || dirty ? '보정함' : '자동 제안'}</small>}</div>
    {!rig ? <button disabled={busy} onClick={() => void run('rig', () => generationsApi.rig(generation.id))}>{working === 'rig' ? '관절 잡는 중' : '관절 자동 잡기'}</button> : <div className="rig-layout">
      <svg ref={svg} className="rig-canvas" viewBox={`0 0 ${rig.width} ${rig.height}`} role="group" aria-label="관절 위치"
        onPointerMove={event => { if (dragging.current) { const next = point(event); if (next) move(dragging.current, next); } }}
        onPointerUp={() => { dragging.current = ''; }} onPointerCancel={() => { dragging.current = ''; }}>
        {(view === 'regions' && regions ? regions : image) && <image href={versioned((view === 'regions' && regions ? regions : image)!)} width={rig.width} height={rig.height} />}
        {links.map(([a, b]) => joints[a] && joints[b] && <line key={`${a}-${b}`} x1={joints[a][0]} y1={joints[a][1]} x2={joints[b][0]} y2={joints[b][1]} className="rig-bone" strokeWidth={radius / 3} />)}
        {Object.entries(joints).map(([name, [x, y]]) => <circle key={name} cx={x} cy={y} r={radius} className="rig-joint" strokeWidth={radius / 3}
          tabIndex={busy ? -1 : 0} role="button" aria-label={`${jointLabels[name] || name} · 방향키로 이동`}
          onPointerDown={event => { if (busy) return; event.currentTarget.setPointerCapture(event.pointerId); dragging.current = name; }}
          onKeyDown={event => nudge(name, event)}><title>{jointLabels[name] || name}</title></circle>)}
      </svg>
      <div className="rig-tools">
        <button disabled={busy || !dirty} onClick={() => void run('rig', () => generationsApi.rig(generation.id, joints, rig.sha256))}>{working === 'rig' ? '저장 중' : '관절 저장'}</button>
        <button disabled={busy || JSON.stringify(joints) === JSON.stringify(rig.proposed)} onClick={() => setJoints(rig.proposed)}>제안 위치로</button>
        {regions && <button aria-pressed={view === 'regions'} disabled={dirty} onClick={() => setView(value => value === 'regions' ? 'image' : 'regions')}>부위 보기</button>}
      </div>
    </div>}
    {rig && <>
      <div className="generation-result-heading"><h2>모션</h2></div>
      <div className="motion-controls">
        <label>동작<select value={input.template} disabled={busy} onChange={event => setInput(value => ({ ...value, template: event.target.value as MotionTemplate }))}>
          {templates.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>세기 {input.strength.toFixed(1)}<input type="range" min={.5} max={1.5} step={.1} value={input.strength} disabled={busy} onChange={event => setInput(value => ({ ...value, strength: Number(event.target.value) }))} /></label>
        <label>속도 {input.speed.toFixed(1)}<input type="range" min={.5} max={2} step={.1} value={input.speed} disabled={busy} onChange={event => setInput(value => ({ ...value, speed: Number(event.target.value) }))} /></label>
        <label>fps<select value={input.fps} disabled={busy} onChange={event => setInput(value => ({ ...value, fps: Number(event.target.value) as MotionInput['fps'] }))}>
          {[12, 15, 24].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>크기<select value={input.size} disabled={busy} onChange={event => setInput(value => ({ ...value, size: Number(event.target.value) as MotionInput['size'] }))}>
          {[240, 360, 480].map(value => <option key={value} value={value}>{value}px</option>)}</select></label>
        <button disabled={busy || dirty} onClick={() => void run('motion', () => generationsApi.motion(generation.id, input))}>{working === 'motion' ? '모션 만드는 중' : '모션 만들기'}</button>
      </div>
      {dirty && <p className="motion-note" role="status">저장하지 않은 관절 변경이 있습니다.</p>}
      {motions.length > 0 && <div className="motion-list">{motions.map(entry => {
        const preview = artifact(entry!.files.webp);
        return <figure key={entry!.template}>
          {preview && <img src={versioned(preview)} alt={`${generation.name} ${templateLabel[entry!.template]}`} loading="lazy" />}
          <figcaption><strong>{templateLabel[entry!.template]}</strong> · {entry!.frames}프레임 · {(entry!.duration_ms / 1000).toFixed(1)}초 · {entry!.size}px{entry!.rig_sha256 !== rig.sha256 ? ' · 이전 관절' : ''}</figcaption>
          <div className="motion-downloads">{formats.map(([format, label]) => {
            const file = artifact(entry!.files[format]);
            return file && <a key={format} href={`${versioned(file)}&download=1`}>{label} {kb(entry!.bytes[format])}</a>;
          })}</div>
        </figure>;
      })}</div>}
    </>}
  </section>;
}
