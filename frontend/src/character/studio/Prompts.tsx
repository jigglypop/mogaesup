import { useEffect, useRef, useState } from 'react';
import { usePolling } from '../use-polling';
import { promptsApi, type PromptItem } from './prompts-api';
import './prompts.css';

const draftKey = 'gaesup.studio.prompt-management-drafts.v1';
type Drafts = Record<string, { value: string; base: string }>;
function readDrafts(): Drafts {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey) || '{}');
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, Drafts[string]] => {
      const value = entry[1] as Partial<Drafts[string]> | null;
      return !!value && typeof value.value === 'string' && typeof value.base === 'string';
    }));
  } catch { return {}; }
}

export default function Prompts() {
  const listing = usePolling(promptsApi.list, 15000);
  const [groupId, setGroupId] = useState(new URLSearchParams(location.search).get('promptGroup') || 'reference');
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState(readDrafts);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const locked = useRef(false), alive = useRef(true);
  const catalog = listing.value;
  const groups = catalog?.groups || [];
  const group = groups.find(item => item.id === groupId) || groups[0];
  const items = group?.items.filter(item => `${item.title}\n${drafts[item.id]?.value ?? item.value}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) || [];
  const selected = items.find(item => item.id === selectedId) || items[0];
  const dirty = groups.flatMap(item => item.items).filter(item => drafts[item.id] && drafts[item.id].value.trim() !== item.value);
  const conflicts = dirty.filter(item => drafts[item.id].base !== item.value);
  const invalid = dirty.some(item => !drafts[item.id].value.trim() || drafts[item.id].value.trim().length > item.max_length);
  const value = selected ? drafts[selected.id]?.value ?? selected.value : '';
  const changed = selected && dirty.some(item => item.id === selected.id);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!catalog) return;
    const saved = Object.fromEntries(catalog.groups.flatMap(group => group.items).map(item => [item.id, item.value]));
    setDrafts(previous => {
      const entries = Object.entries(previous).filter(([id, draft]) => draft.value.trim() !== saved[id]);
      return entries.length === Object.keys(previous).length ? previous : Object.fromEntries(entries);
    });
  }, [catalog]);
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify(drafts)); }
    catch { setError('편집 내용을 임시저장하지 못했습니다. 화면을 닫기 전에 저장해 주세요.'); }
  }, [drafts]);

  function edit(item: PromptItem, value: string) {
    setMessage('');
    setDrafts(previous => {
      const next = { ...previous };
      if (value === item.value) delete next[item.id];
      else next[item.id] = { value, base: previous[item.id]?.base ?? item.value };
      return next;
    });
  }
  function discard(item: PromptItem) {
    setDrafts(previous => { const next = { ...previous }; delete next[item.id]; return next; });
    setMessage('');
  }
  async function save() {
    if (locked.current || !catalog || !dirty.length || conflicts.length || invalid) return;
    locked.current = true; setBusy(true); setError(''); setMessage('');
    const submitted = Object.fromEntries(dirty.map(item => [item.id,
      drafts[item.id].value.trim() === item.default ? null : drafts[item.id].value.trim()]));
    try {
      const result = await promptsApi.save(submitted, catalog.revision);
      if (!alive.current) return;
      listing.setValue(result);
      setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !(id in submitted))));
      setMessage(`${dirty.length}개 프롬프트 저장됨`);
    } catch (cause) {
      if (alive.current) { setError((cause as Error).message); void listing.refresh(); }
    } finally {
      locked.current = false; if (alive.current) setBusy(false);
    }
  }

  return <div className="workspace-content prompt-manager" aria-busy={busy}>
    <div className="workspace-heading"><h1>프롬프트 관리</h1><div className="prompt-actions">
      <span role="status">{busy ? '저장 중' : message || (dirty.length ? `${dirty.length}개 미저장` : '저장된 기본값')}</span>
      <button disabled={busy || listing.loading} onClick={() => void listing.refresh()}>새로고침</button>
      <button className="prompt-save" disabled={busy || !catalog?.can_save || !dirty.length || !!conflicts.length || invalid} onClick={() => void save()}>변경 저장</button>
    </div></div>
    <p className="prompt-scope">저장한 내용은 새 생성 작업의 기본값으로 사용됩니다. 생성 화면에서 직접 수정한 내용이 우선하며, 접수된 작업은 기존 프롬프트를 유지합니다.</p>
    {(error || listing.error) && <p className="workspace-error" role="alert">{error || listing.error}</p>}
    {catalog && !catalog.can_save && <p className="workspace-error" role="alert">S3 저장소 연결 후 저장할 수 있습니다.</p>}
    {!!conflicts.length && <p className="workspace-error" role="alert">다른 화면에서 변경됨: {conflicts.map(item => item.title).join(', ')}. 해당 항목의 최신 저장값을 확인하고 편집을 다시 적용하세요.</p>}
    {!catalog ? <p>{listing.loading ? '프롬프트 불러오는 중' : '프롬프트를 불러오지 못했습니다.'}</p> : <>
      <nav className="prompt-groups" aria-label="프롬프트 분류">{groups.map(item => <button key={item.id} aria-pressed={group?.id === item.id} onClick={() => { setGroupId(item.id); setSelectedId(''); setQuery(''); }}>
        {item.title}<span>{item.items.length}</span>{dirty.some(prompt => item.items.includes(prompt)) && <i aria-label="미저장 변경">●</i>}
      </button>)}</nav>
      <div className="prompt-layout">
        <aside className="prompt-list"><label>프롬프트 검색<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="이름 또는 내용" /></label>
          <nav aria-label="프롬프트 목록">{items.map(item => <button key={item.id} aria-current={selected?.id === item.id ? 'true' : undefined} onClick={() => setSelectedId(item.id)}>
            <strong>{item.title}</strong><span>{dirty.some(prompt => prompt.id === item.id) ? '미저장' : item.customized ? '사용자 설정' : '기본값'}</span>
          </button>)}</nav>{!items.length && <p>검색 결과 없음</p>}
        </aside>
        {selected && <section className="prompt-editor">
          <div className="prompt-editor-heading"><h2>{selected.title}</h2><span>{changed ? '편집 중' : selected.customized ? '사용자 설정' : '기본값'}</span></div>
          <p className="prompt-rule">{group?.rule}</p>
          <label htmlFor="managed-prompt">생성 프롬프트</label>
          <textarea id="managed-prompt" spellCheck={false} value={value} maxLength={selected.max_length} disabled={busy} onChange={event => edit(selected, event.target.value)} />
          <div className="prompt-editor-footer"><span>{value.length.toLocaleString()} / {selected.max_length.toLocaleString()}자</span><div className="prompt-actions">
            <button disabled={busy || !drafts[selected.id]} onClick={() => discard(selected)}>최신 저장값으로 되돌리기</button>
            <button disabled={busy || value === selected.default} onClick={() => edit(selected, selected.default)}>기본값 복원</button>
          </div></div>
          <details><summary>한글 기본 프롬프트 보기</summary><p>{selected.default}</p></details>
          {conflicts.some(item => item.id === selected.id) && <details open><summary>다른 화면에서 저장한 내용</summary><p>{selected.value}</p></details>}
        </section>}
      </div>
    </>}
  </div>;
}
