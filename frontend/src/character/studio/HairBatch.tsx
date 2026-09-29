import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { factoryApi, type FactoryJob } from '../factory/api';
import { usePolling } from '../use-polling';
import { meshyDefaultsFor } from './meshy-options';
import { hairBatchesApi, type HairBatch as HairBatchRecord, type HairSheetItem, type HairView } from './hair-batches-api';
import './hair-batch.css';

const sheetSize = 1254;
const attachedRowEdges = [0,193,388,626,829,1016,1254].map(value => value / sheetSize);
const attachedViewEdges = [
  [0,172,296,424,572,699,830,978,1105,1254],
  [0,170,295,418,590,704,832,981,1105,1254],
  [0,171,294,421,570,694,833,979,1106,1254],
  [0,175,304,432,582,701,835,985,1106,1254],
  [0,168,290,419,571,695,830,984,1109,1254],
  [0,168,285,418,575,696,835,980,1109,1254],
].map(row => row.map(value => value / sheetSize));
const equalEdges = (count: number) => Array.from({length:count+1},(_,index)=>index/count);
const viewLabels: Record<HairView, string> = { front: '정면', back: '후면', side: '측면' };
const stateLabels: Record<string,string> = {accepted:'접수됨',queued:'대기',running:'처리 중',complete:'저장 완료',paused:'이어가기 필요'};
const fourViewLabels: Record<string,string> = {front:'정면',side:'좌측면',back:'후면',opposite:'우측면'};
const imageStateLabels: Record<string,string> = {pending:'대기',submitting:'응답 대기',received:'배경 처리 중'};
const assetUrl = (id: string) => `/api/avatar-blueprints/assets/${encodeURIComponent(id)}`;
const draftKey = 'gaesup.hair-batch.draft.v1';
type InputMode = 'multi'|'sheet';
type Regeneration = {batchId:string;selected:number[];facing:'left'|'right';notes:string;worn:boolean};
type Draft = {mode:InputMode;source:{id:string;name:string}|null;rows:number;columns:number;layout:'attached'|'equal';order:HairView[];removeSkin:boolean;items:HairSheetItem[];selected:number[];redrawNotes:string;sourceSideFacing:'left'|'right';worn:boolean};
const emptyDraft: Draft = {mode:'multi',source:null,rows:6,columns:3,layout:'attached',order:['front','back','side'],removeSkin:false,items:[],selected:[],redrawNotes:'',sourceSideFacing:'right',worn:true};
function readDraft(): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey) || 'null') as Partial<Draft> | null;
    if (!value) return emptyDraft;
    const source = value.source && /^[a-f0-9]{64}$/.test(value.source.id) && typeof value.source.name === 'string' ? value.source : null;
    const items = Array.isArray(value.items) && value.items.every(item => typeof item?.name === 'string' && Number.isInteger(item.row) && Number.isInteger(item.column)
      && (['front','side','back'] as const).every(view=>/^[a-f0-9]{64}$/.test(item.views?.[view]))) ? value.items : [];
    const selected = Array.isArray(value.selected) ? value.selected.filter(index=>Number.isInteger(index) && index >= 0 && index < items.length) : [];
    const layout = value.layout === 'equal' ? 'equal' : 'attached';
    const rows = layout === 'attached' ? 6 : Number.isInteger(value.rows) ? Number(value.rows) : 6;
    const columns = layout === 'attached' ? 3 : Number.isInteger(value.columns) ? Number(value.columns) : 3;
    const order = Array.isArray(value.order) && value.order.length === 3 && new Set(value.order).size === 3
      && value.order.every(view=>['front','side','back'].includes(view)) ? value.order as HairView[] : emptyDraft.order;
    const mode: InputMode = value.mode === 'sheet' || (!value.mode && source) ? 'sheet' : 'multi';
    return {mode,source,rows,columns,layout,order,removeSkin:value.removeSkin === true,items,selected,
      redrawNotes:typeof value.redrawNotes === 'string' ? value.redrawNotes.slice(0,2000) : '',
      worn:typeof value.worn === 'boolean' ? value.worn : true,
      sourceSideFacing:value.sourceSideFacing === 'left' ? 'left' : 'right'};
  } catch { return emptyDraft; }
}

export function HairBatch({baseId, version, disabled, setup, onJob}: {baseId?: string; version?: string; disabled: boolean; setup?: ReactNode; onJob: (job: FactoryJob) => void}) {
  const readBatches = useCallback((signal: AbortSignal) => hairBatchesApi.list(signal), []);
  const batches = usePolling(readBatches, 5000);
  const initialRecovery = useRef(hairBatchesApi.recovery());
  const initialDraft = useRef(readDraft());
  const [mode,setMode] = useState<InputMode>(initialDraft.current.mode);
  const [source, setSource] = useState(initialDraft.current.source);
  const [rows,setRows] = useState(initialDraft.current.rows), [columns,setColumns] = useState(initialDraft.current.columns);
  const [layout,setLayout] = useState<'attached'|'equal'>(initialDraft.current.layout);
  const [order,setOrder] = useState<HairView[]>(initialDraft.current.order), [removeSkin,setRemoveSkin] = useState(initialDraft.current.removeSkin);
  const [items,setItems] = useState<HairSheetItem[]>(initialDraft.current.items), [selected,setSelected] = useState<number[]>(initialDraft.current.selected);
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [redrawNotes,setRedrawNotes] = useState(initialDraft.current.redrawNotes);
  const [worn,setWorn] = useState(initialDraft.current.worn);
  const [sourceSideFacing,setSourceSideFacing] = useState(initialDraft.current.sourceSideFacing);
  const [pending,setPending] = useState(initialRecovery.current.pending);
  const submitLock = useRef(false);
  const resumeLocks = useRef(new Set<string>());
  const [uploadProgress,setUploadProgress] = useState('');
  const [panel,setPanel] = useState<'input'|'saved'>('input');
  const [expandedBatch,setExpandedBatch] = useState('');
  const [regeneration,setRegeneration] = useState<Regeneration|null>(null);
  const recoveryError = initialRecovery.current.error;
  const rowEdges = useMemo(() => layout === 'attached' ? attachedRowEdges : equalEdges(rows), [layout, rows]);
  const validGrid = Number.isInteger(rows) && rows >= 1 && rows <= 12 && Number.isInteger(columns) && columns >= 1 && columns <= 8 && rows * columns <= 48;
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify({mode,source,rows,columns,layout,order,removeSkin,items,selected,redrawNotes,sourceSideFacing,worn} satisfies Draft)); }
    catch { /* Draft persistence must not block batch controls. */ }
  }, [mode, source, rows, columns, layout, order, removeSkin, items, selected, redrawNotes, sourceSideFacing, worn]);
  async function upload(file?: File) {
    if (!file) return; setBusy(true);setError('');
    try { const result = await hairBatchesApi.uploadSheet(file); setSource({id:result.id,name:file.name});setItems([]);setSelected([]); }
    catch(e){setError((e as Error).message);} finally{setBusy(false);}
  }
  async function split() {
    if(!source)return;setBusy(true);setError('');
    try {
      if (!validGrid) throw new Error('행 1~12, 스타일 1~8, 전체 48종 이하로 입력하세요.');
      const result = await hairBatchesApi.splitSheet({asset_id:source.id,rows,columns,row_edges:rowEdges,
        ...(layout === 'attached' ? {view_edges:attachedViewEdges} : {}),view_order:order,remove_skin:removeSkin});
      setItems(result.items);setSelected(result.items.map((_,i)=>i));
    } catch(e){setError((e as Error).message);} finally{setBusy(false);}
  }
  async function uploadMultiple(files: File[]) {
    if (!files.length) return;
    const ordered = [...files].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'}));
    if (ordered.length > 48) { setError('3뷰 이미지는 한 번에 최대 48개까지 선택하세요.'); return; }
    setBusy(true);setError('');setSource(null);setItems([]);setSelected([]);setUploadProgress(`0 / ${ordered.length}`);
    const completed: Array<HairSheetItem|undefined> = new Array(ordered.length);
    const failures: Array<string|undefined> = new Array(ordered.length);
    let cursor=0,done=0;
    const worker = async () => {
      while (true) {
        const index=cursor++;
        if(index>=ordered.length)return;
        const file=ordered[index];
        try {
          const uploaded=await hairBatchesApi.uploadSheet(file);
          const splitResult=await hairBatchesApi.splitSheet({asset_id:uploaded.id,rows:1,columns:1,row_edges:[0,1],view_order:order,remove_skin:false,detect_view_seams:true});
          const item=splitResult.items[0];
          if(!item)throw new Error('분할 결과가 없습니다.');
          completed[index]={...item,row:index+1,name:(file.name.replace(/\.[^.]+$/,'').trim()||`헤어 ${index+1}`).slice(0,100)};
          const visible=completed.filter((value):value is HairSheetItem=>!!value);
          setItems(visible);setSelected(visible.map((_,itemIndex)=>itemIndex));
        } catch { failures[index]=file.name; }
        finally { done++;setUploadProgress(`${done} / ${ordered.length}`); }
      }
    };
    try {
      await Promise.all(Array.from({length:Math.min(3,ordered.length)},()=>worker()));
      const failed=failures.filter((value):value is string=>!!value);
      if(failed.length)setError(`${failed.length}개 파일을 처리하지 못했습니다: ${failed.join(', ')}`);
    } finally { setBusy(false);setUploadProgress(''); }
  }
  async function generate() {
    if(submitLock.current)return;submitLock.current=true;setBusy(true);setError('');
    try {
      if (!pending) {
        if(!baseId || !version || !selected.length)throw new Error('기준 몸과 생성할 스타일을 선택하세요.');
      }
      const input = pending?.input || {base_job_id:baseId!,base_version:version!,items:selected.map(i=>({name:items[i].name.trim(),views:items[i].views})),concurrency:4,meshy_options:meshyDefaultsFor('hair'),
        redraw:{notes:redrawNotes.trim(),source_side_facing:sourceSideFacing,...(worn ? {worn:true} : {})}};
      const created = await hairBatchesApi.create(input);
      setPending(null);
      setPanel('saved');setExpandedBatch(created.id);
      batches.setValue(current => ({items:[created, ...(current?.items || []).filter(batch => batch.id !== created.id)]}));
      void batches.refresh();
    }catch(e){setPending(hairBatchesApi.recovery().pending);setError((e as Error).message);}finally{submitLock.current=false;setBusy(false);}
  }
  async function resume(id:string){
    if(resumeLocks.current.has(id))return;
    resumeLocks.current.add(id);setBusy(true);setError('');
    try {
      const resumed=await hairBatchesApi.resume(id);
      batches.setValue(current=>({items:(current?.items || []).map(batch=>batch.id===id?resumed:batch)}));
      void batches.refresh();
    }catch(e){setError((e as Error).message);}finally{resumeLocks.current.delete(id);setBusy(false);}
  }
  async function open(jobId:string){try{onJob(await factoryApi.detail(jobId));}catch(e){setError((e as Error).message);}}
  function startRegeneration(batch:HairBatchRecord) {
    setExpandedBatch(batch.id);setError('');
    setRegeneration({batchId:batch.id,selected:batch.input.items.map((_,index)=>index),
      facing:batch.input.redraw?.source_side_facing || 'right',notes:batch.input.redraw?.notes || '',worn:batch.input.redraw?.worn ?? true});
  }
  async function regenerate(batch:HairBatchRecord) {
    if(!regeneration || submitLock.current)return;
    submitLock.current=true;setBusy(true);setError('');
    try {
      if(!regeneration.selected.length)throw new Error('다시 생성할 헤어를 선택하세요.');
      // Same originals and body; fresh four-view redraw with the light hair Meshy preset.
      const created = await hairBatchesApi.create({base_job_id:batch.input.base_job_id,base_version:batch.input.base_version,
        items:[...regeneration.selected].sort((a,b)=>a-b).map(index=>batch.input.items[index]),
        concurrency:batch.input.concurrency,meshy_options:meshyDefaultsFor('hair'),
        redraw:{notes:regeneration.notes.trim(),source_side_facing:regeneration.facing,...(regeneration.worn ? {worn:true} : {})}});
      setRegeneration(null);setExpandedBatch(created.id);
      batches.setValue(current => ({items:[created, ...(current?.items || []).filter(value => value.id !== created.id)]}));
      void batches.refresh();
    }catch(e){setPending(hairBatchesApi.recovery().pending);setError((e as Error).message);}finally{submitLock.current=false;setBusy(false);}
  }
  function useEqualGrid(nextRows = rows, nextColumns = columns) {
    setRows(nextRows); setColumns(nextColumns); setLayout('equal'); setItems([]); setSelected([]);
  }
  return <section className="hair-batch" aria-label="헤어 일괄 생성">
    <div className="hair-batch-panels" role="group" aria-label="헤어 배치 화면"><button aria-pressed={panel === 'input'} onClick={()=>setPanel('input')}>새 배치</button><button aria-pressed={panel === 'saved'} onClick={()=>setPanel('saved')}>저장된 작업{batches.value ? ` · ${batches.value.items.length}` : ''}</button></div>
    <div hidden={panel !== 'input'}>
    <div className="hair-batch-setup">{setup}</div>
    <fieldset className="hair-batch-inputs" disabled={busy || !!pending || disabled || !!recoveryError}>
      <label>입력 방식<select value={mode} onChange={event=>{setMode(event.target.value as InputMode);setSource(null);setItems([]);setSelected([]);setError('');}}><option value="multi">3뷰 이미지 여러 장</option><option value="sheet">한 장 시트</option></select></label>
      {mode==='multi' ? <label>3뷰 이미지<input type="file" multiple accept="image/png,image/jpeg" onChange={event=>void uploadMultiple(Array.from(event.target.files||[]))}/></label> : <>
      <label>원본 시트<input type="file" accept="image/png,image/jpeg" onChange={event=>void upload(event.target.files?.[0])}/></label>
      {source && <small>{source.name} · 업로드 완료</small>}
      <label>시트 레이아웃<select value={layout} onChange={event=>{const next=event.target.value as typeof layout;setLayout(next);setRows(6);setColumns(3);setItems([]);setSelected([]);}}><option value="attached">첨부 헤어 시트 · 18종</option><option value="equal">등간격</option></select></label>
      <div className="hair-batch-grid"><label>행<input type="number" min={1} max={12} value={rows} onChange={e=>useEqualGrid(Number(e.target.value),columns)}/></label><label>한 행 스타일 수<input type="number" min={1} max={8} value={columns} onChange={e=>useEqualGrid(rows,Number(e.target.value))}/></label></div></>}
      <label>각 스타일의 뷰 순서<select value={order.join(',')} onChange={e=>setOrder(e.target.value.split(',') as HairView[])}><option value="front,back,side">정면 · 후면 · 측면</option><option value="front,side,back">정면 · 측면 · 후면</option></select></label>
      {mode==='sheet' && <><label className="hair-batch-check"><input type="checkbox" checked={removeSkin} onChange={e=>setRemoveSkin(e.target.checked)}/>피부색 제거 · 흑백 헤어용</label>
      {!validGrid && <small role="alert">행 1~12, 스타일 1~8, 전체 48종 이하로 입력하세요.</small>}
      <button disabled={!source || !validGrid} onClick={()=>void split()}>시트 자르기</button></>}
      {!!items.length && <div className="hair-batch-selection"><span>{items.length}종 중 {selected.length}종 선택</span><button type="button" onClick={()=>setSelected(selected.length===items.length?[]:items.map((_,i)=>i))}>{selected.length===items.length?'전체 해제':'전체 선택'}</button></div>}
      <div className="hair-batch-items">{items.map((item,index)=><article className="hair-batch-item" key={`${item.row}:${item.column}`}><label className="hair-batch-check"><input type="checkbox" checked={selected.includes(index)} onChange={e=>setSelected(current=>e.target.checked?[...current,index]:current.filter(i=>i!==index))}/><input aria-label={`스타일 ${index+1} 이름`} value={item.name} maxLength={100} onChange={e=>setItems(current=>current.map((v,i)=>i===index?{...v,name:e.target.value}:v))}/></label><div className="hair-batch-views">{(['front','back','side'] as const).map(view=><figure key={view}><img src={assetUrl(item.views[view])} loading="lazy" alt={`${item.name} ${viewLabels[view]}`}/><figcaption>{viewLabels[view]}</figcaption></figure>)}</div></article>)}</div>
      <label>원본 측면의 얼굴 방향<select value={sourceSideFacing} onChange={e=>setSourceSideFacing(e.target.value as 'left'|'right')}><option value="right">이미지 오른쪽</option><option value="left">이미지 왼쪽</option></select></label>
      <label>보정 내용<textarea value={redrawNotes} maxLength={2000} rows={2} onChange={e=>setRedrawNotes(e.target.value)}/></label>
      <label className="hair-batch-check"><input type="checkbox" checked={worn} onChange={e=>setWorn(e.target.checked)}/>기본 몸 머리에 씌워 생성</label>
    </fieldset>
    {uploadProgress && <p role="status">3뷰 이미지 처리 중 · {uploadProgress}</p>}
    <button disabled={busy || !!recoveryError || (!pending && (disabled || !baseId || !version || !selected.length || selected.some(index=>!items[index].name.trim())))} onClick={()=>void generate()}>{pending?'같은 요청 키로 접수 복구':`${selected.length}종 생성 · 유료 이미지 ${selected.length*(worn?3:4)}장 + 3D ${selected.length}회`}</button>
    {pending && <small className="generation-recovery">응답이 확인되지 않은 배치입니다. 입력과 요청 키를 유지해 결과를 복구합니다.</small>}
    </div>
    {(error || recoveryError || batches.error) && <p role="alert">{error || recoveryError || batches.error}</p>}
    <div hidden={panel !== 'saved'}>
    {batches.loading && !batches.value && <p>배치 목록 불러오는 중</p>}
    {!batches.loading && !batches.value?.items.length && <p>저장된 헤어 배치가 없습니다.</p>}
    {batches.value?.items.map((batch:HairBatchRecord)=><details key={batch.id} open={expandedBatch === batch.id}><summary onClick={event=>{event.preventDefault();setExpandedBatch(current=>current === batch.id ? '' : batch.id);}}>{new Date(batch.created_at).toLocaleDateString()} · {batch.input.items.length}종 · {batch.completed} 저장 · {stateLabels[batch.status] || batch.status}</summary>
      {batch.error && <p role="alert">{batch.error}</p>}
      {regeneration?.batchId === batch.id ? <fieldset className="hair-batch-regenerate" disabled={busy || !!pending || disabled || !!recoveryError}>
        <div className="hair-batch-selection"><span>{batch.input.items.length}종 중 {regeneration.selected.length}종 선택</span><button type="button" onClick={()=>setRegeneration({...regeneration,selected:regeneration.selected.length===batch.input.items.length?[]:batch.input.items.map((_,index)=>index)})}>{regeneration.selected.length===batch.input.items.length?'전체 해제':'전체 선택'}</button></div>
        <figure className="hair-batch-facing"><img src={assetUrl(batch.input.items[0].views.side)} alt={`${batch.input.items[0].name} 원본 측면`}/><figcaption>원본 측면</figcaption></figure>
        <label>원본 측면의 얼굴 방향<select value={regeneration.facing} onChange={e=>setRegeneration({...regeneration,facing:e.target.value as 'left'|'right'})}><option value="right">이미지 오른쪽</option><option value="left">이미지 왼쪽</option></select></label>
        <label>보정 내용<textarea value={regeneration.notes} maxLength={2000} rows={2} onChange={e=>setRegeneration({...regeneration,notes:e.target.value})}/></label>
        <label className="hair-batch-check"><input type="checkbox" checked={regeneration.worn} onChange={e=>setRegeneration({...regeneration,worn:e.target.checked})}/>기본 몸 머리에 씌워 생성</label>
        <div className="hair-batch-actions"><button onClick={()=>void regenerate(batch)} disabled={!regeneration.selected.length}>{regeneration.selected.length}종 다시 생성 · 이미지 {regeneration.selected.length*(regeneration.worn?3:4)}장 + 3D {regeneration.selected.length}회</button><button type="button" onClick={()=>setRegeneration(null)}>취소</button></div>
      </fieldset> : <button disabled={busy || !!pending || disabled || !!recoveryError} onClick={()=>startRegeneration(batch)}>다시 생성</button>}
      <div className="hair-batch-items">{expandedBatch === batch.id && batch.items.map(item=><article className="hair-batch-item" key={item.index}>
        <header className="hair-batch-item-head">{regeneration?.batchId === batch.id && <input type="checkbox" aria-label={`${item.name} 다시 생성 선택`} checked={regeneration.selected.includes(item.index)} onChange={e=>setRegeneration({...regeneration,selected:e.target.checked?[...regeneration.selected,item.index]:regeneration.selected.filter(index=>index!==item.index)})}/>}<strong>{item.name}</strong><span className={`hair-batch-state is-${item.status}`}>{stateLabels[item.status] || item.status}</span></header>
        {item.prepared_views?.length ? <div className="hair-batch-views hair-batch-four">{item.prepared_views.map(view=><figure key={view.view}>
          {view.url ? <a href={view.url} target="_blank" rel="noreferrer"><img src={view.url} loading="lazy" alt={`${item.name} ${fourViewLabels[view.view]}`}/></a> : <div className="hair-batch-placeholder"/>}
          <figcaption>{fourViewLabels[view.view]}{view.status === 'succeeded' ? '' : ` · ${imageStateLabels[view.status] || '이어가기 필요'}`}</figcaption>
          {view.background_removal?.alpha_min === 255 && <small>배경이 남아 있음</small>}
        </figure>)}</div> : <div className="hair-batch-views">{(['front','back','side'] as const).map(view=><figure key={view}><img src={assetUrl(batch.input.items[item.index].views[view])} loading="lazy" alt={`${item.name} 원본 ${viewLabels[view]}`}/><figcaption>원본 {viewLabels[view]}</figcaption></figure>)}</div>}
        {item.progress?.message && item.status !== 'complete' && <small>{item.progress.message}</small>}
        {(item.error||item.state_error) && <p role="alert">{item.error||item.state_error}</p>}
        <button disabled={item.status==='queued' || !item.job_id} onClick={()=>void open(item.job_id)}>결과 보기</button></article>)}</div>
      {batch.can_resume && <button disabled={busy} onClick={()=>void resume(batch.id)}>저장된 작업 이어가기</button>}
    </details>)}
    </div>
  </section>;
}
