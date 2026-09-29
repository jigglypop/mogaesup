import { useMemo, useRef, useState } from 'react';

import { createPortal } from 'react-dom';

import type { AdminCatalogItem, CatalogChanges, CatalogImport, CatalogKind, CatalogStatus } from '../../api/types';
import { Icon } from '../../ui/icons';
import {
  ITEM_SORTS,
  KIND_LABEL,
  SOURCE_LABEL,
  STATUS_LABEL,
  activeImportFor,
  filterItems,
  parseSortOrder,
  sortItems,
  textProblem,
  type ItemFilter,
  type ItemSort,
} from './catalogView';
import { NARROW, useMediaQuery } from './hooks';
import { ImportProgress, ThumbButton } from './parts';
import type { PreviewTarget } from './PreviewDialog';

const STATUSES: readonly CatalogStatus[] = ['draft', 'published', 'retired'];

/** A value shown as text that turns into a field on tap; Enter or leaving the field saves, Escape cancels. */
function Editable({
  value,
  label,
  disabled,
  check,
  onSave,
  inputMode,
}: {
  value: string;
  label: string;
  disabled: boolean;
  check: (text: string) => string | null;
  onSave: (text: string) => Promise<boolean>;
  inputMode?: 'numeric';
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const saving = useRef(false);
  if (draft === null) {
    return (
      <button
        type="button"
        className="mg-admin-inline"
        disabled={disabled}
        title={`${label} 고치기`}
        aria-label={`${label}: ${value}, 고치기`}
        onClick={() => {
          setDraft(value);
          setProblem(null);
        }}
      >
        <span>{value}</span>
        <Icon name="edit" />
      </button>
    );
  }
  const commit = async () => {
    if (saving.current) return;
    const text = draft.trim();
    if (text === value) return setDraft(null);
    const issue = check(text);
    if (issue) return setProblem(issue);
    saving.current = true;
    const ok = await onSave(text);
    saving.current = false;
    if (ok) setDraft(null);
  };
  return (
    <span className="mg-admin-inline-edit">
      <input
        className="mg-field"
        autoFocus
        value={draft}
        aria-label={label}
        aria-invalid={problem ? true : undefined}
        inputMode={inputMode}
        onChange={(event) => {
          setDraft(event.target.value);
          setProblem(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(null);
          }
        }}
        onBlur={() => void commit()}
      />
      {problem && <small className="mg-error">{problem}</small>}
    </span>
  );
}

type RowProps = {
  item: AdminCatalogItem;
  running: CatalogImport | undefined;
  busy: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onPatch: (item: AdminCatalogItem, changes: CatalogChanges) => Promise<boolean>;
  onStatus: (item: AdminCatalogItem, next: CatalogStatus) => void;
  onPreview: (target: PreviewTarget) => void;
  onVersions: (item: AdminCatalogItem) => void;
};

/** The pieces of one item, laid out as a table row or as a card. */
function cellsOf({ item, running, busy, selected, onSelect, onPatch, onStatus, onPreview, onVersions }: RowProps) {
  // An import only swaps the model, picture and clips, so edits stay open while one runs.
  const locked = busy;
  return {
    select: (
      <label className="mg-admin-check" title="고르기">
        <input type="checkbox" checked={selected} aria-label={`${item.label} 고르기`} onChange={(event) => onSelect(event.target.checked)} />
      </label>
    ),
    thumb: <ThumbButton src={item.thumbnailUrl} fallback={item.emoji} label={item.label} onClick={() => onPreview({ title: item.label, url: item.modelUrl })} />,
    label: (
      <Editable value={item.label} label="이름" disabled={locked} check={(text) => textProblem(text, 30)} onSave={(label) => onPatch(item, { label })} />
    ),
    emoji: (
      <span className="mg-admin-emoji">
        <Editable value={item.emoji} label="이모지" disabled={locked} check={(text) => textProblem(text, 16)} onSave={(emoji) => onPatch(item, { emoji })} />
      </span>
    ),
    order: (
      <Editable
        value={String(item.sortOrder)}
        label="순서"
        inputMode="numeric"
        disabled={locked}
        check={(text) => (parseSortOrder(text) === null ? '정수를 넣어 주세요' : null)}
        onSave={(text) => onPatch(item, { sortOrder: parseSortOrder(text) ?? item.sortOrder })}
      />
    ),
    clips: item.clips.length ? item.clips.join(' · ') : '—',
    status: (
      <select
        className="mg-field mg-admin-select"
        value={item.status}
        disabled={locked}
        aria-label={`${item.label} 상태`}
        onChange={(event) => onStatus(item, event.target.value as CatalogStatus)}
      >
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABEL[status]}
          </option>
        ))}
      </select>
    ),
    actions: (
      <span className="mg-admin-actions">
        <button type="button" className="mg-btn is-quiet is-small" onClick={() => onPreview({ title: item.label, url: item.modelUrl })}>
          <Icon name="eye" /> 3D
        </button>
        {item.versionCount > 0 && (
          <button type="button" className="mg-btn is-quiet is-small" onClick={() => onVersions(item)}>
            기록 {item.versionCount}
          </button>
        )}
      </span>
    ),
    progress: running ? <ImportProgress item={running} compact /> : null,
  };
}

function TableRow(props: RowProps) {
  const { item } = props;
  const cells = cellsOf(props);
  return (
    <tr className={props.selected ? 'is-selected' : undefined}>
      <td>{cells.select}</td>
      <td>{cells.thumb}</td>
      <td className="mg-admin-name-cell">
        {cells.label}
        <code>{item.id}</code>
        {cells.progress}
      </td>
      <td>{cells.emoji}</td>
      <td>{cells.order}</td>
      <td className="mg-muted">{cells.clips}</td>
      <td>
        {SOURCE_LABEL[item.source]}
        <small className="mg-admin-block">{KIND_LABEL[item.kind]}</small>
      </td>
      <td>{item.kind === 'minime' ? item.usage.toLocaleString('ko-KR') : '—'}</td>
      <td>{cells.status}</td>
      <td>{cells.actions}</td>
    </tr>
  );
}

function ItemCard(props: RowProps) {
  const { item } = props;
  const cells = cellsOf(props);
  return (
    <li className={`mg-admin-item-card${props.selected ? ' is-selected' : ''}`}>
      <div className="mg-admin-item-top">
        {cells.select}
        {cells.thumb}
        <div className="mg-admin-name-cell">
          {cells.label}
          <code>{item.id}</code>
        </div>
      </div>
      {cells.progress}
      <dl className="mg-admin-item-facts">
        <div>
          <dt>이모지</dt>
          <dd>{cells.emoji}</dd>
        </div>
        <div>
          <dt>순서</dt>
          <dd>{cells.order}</dd>
        </div>
        <div>
          <dt>출처</dt>
          <dd>
            {SOURCE_LABEL[item.source]} · {KIND_LABEL[item.kind]}
          </dd>
        </div>
        <div>
          <dt>사용</dt>
          <dd>{item.kind === 'minime' ? `섬 ${item.usage.toLocaleString('ko-KR')}곳` : '—'}</dd>
        </div>
        <div className="is-wide">
          <dt>동작</dt>
          <dd>{cells.clips}</dd>
        </div>
      </dl>
      <div className="mg-admin-item-bottom">
        {cells.status}
        {cells.actions}
      </div>
    </li>
  );
}

type TableProps = {
  items: AdminCatalogItem[] | null;
  imports: CatalogImport[];
  busy: ReadonlySet<string>;
  onPatch: (item: AdminCatalogItem, changes: CatalogChanges) => Promise<boolean>;
  onStatus: (item: AdminCatalogItem, next: CatalogStatus) => void;
  onBulk: (items: AdminCatalogItem[], next: CatalogStatus) => Promise<boolean>;
  onPreview: (target: PreviewTarget) => void;
  onVersions: (item: AdminCatalogItem) => void;
};

/** `/admin/catalog`: every item, to find, sort, edit in place, move between draft, public and retired, one or many. */
export function CatalogTable({ items, imports, busy, onPatch, onStatus, onBulk, onPreview, onVersions }: TableProps) {
  const narrow = useMediaQuery(NARROW);
  const [filter, setFilter] = useState<ItemFilter>({ query: '', kind: 'all', status: 'all', source: 'all' });
  const [sort, setSort] = useState<ItemSort>('order');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const shown = useMemo(() => sortItems(filterItems(items ?? [], filter), sort), [items, filter, sort]);
  // Only rows still on screen count as chosen, so a filter never acts on hidden items.
  const chosen = shown.filter((item) => selected.has(item.id));
  const everything = shown.length > 0 && chosen.length === shown.length;
  const pick = (id: string, on: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const bulk = async (next: CatalogStatus) => {
    if (await onBulk(chosen, next)) setSelected(new Set());
  };
  const rowProps = (item: AdminCatalogItem): RowProps => ({
    item,
    running: activeImportFor(imports, { itemId: item.id }),
    busy: busy.has(item.id),
    selected: selected.has(item.id),
    onSelect: (on) => pick(item.id, on),
    onPatch,
    onStatus,
    onPreview,
    onVersions,
  });

  const actions = (
    <span className="mg-admin-actions">
      <button type="button" className="mg-btn is-primary is-small" disabled={busy.has('bulk')} onClick={() => void bulk('published')}>
        공개
      </button>
      <button type="button" className="mg-btn is-small" disabled={busy.has('bulk')} onClick={() => void bulk('draft')}>
        초안으로
      </button>
      <button type="button" className="mg-btn is-small" disabled={busy.has('bulk')} onClick={() => void bulk('retired')}>
        내리기
      </button>
      <button type="button" className="mg-btn is-quiet is-small" onClick={() => setSelected(new Set())}>
        고르기 취소
      </button>
    </span>
  );

  return (
    <div className={`mg-admin-catalog${narrow && chosen.length ? ' is-selecting' : ''}`}>
      <div className="mg-admin-toolbar">
        <input
          className="mg-field mg-admin-search"
          type="search"
          value={filter.query}
          placeholder="ID·이름·캐릭터로 찾기"
          aria-label="카탈로그 찾기"
          onChange={(event) => setFilter({ ...filter, query: event.target.value })}
        />
        <select className="mg-field mg-admin-select" aria-label="종류" value={filter.kind} onChange={(event) => setFilter({ ...filter, kind: event.target.value as CatalogKind | 'all' })}>
          <option value="all">모든 종류</option>
          <option value="minime">미니미</option>
          <option value="furniture">가구</option>
        </select>
        <select className="mg-field mg-admin-select" aria-label="상태" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as CatalogStatus | 'all' })}>
          <option value="all">모든 상태</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
        <select className="mg-field mg-admin-select" aria-label="출처" value={filter.source} onChange={(event) => setFilter({ ...filter, source: event.target.value as ItemFilter['source'] })}>
          <option value="all">모든 출처</option>
          <option value="builtin">기본</option>
          <option value="factory">캐릭터 스튜디오</option>
        </select>
        <select className="mg-field mg-admin-select" aria-label="정렬" value={sort} onChange={(event) => setSort(event.target.value as ItemSort)}>
          {ITEM_SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className={`mg-admin-bulk${chosen.length ? ' is-on' : ''}`} role="region" aria-label="한꺼번에 바꾸기">
        <label className="mg-admin-check">
          <input
            type="checkbox"
            checked={everything}
            disabled={!shown.length}
            aria-label="보이는 항목 모두 고르기"
            onChange={(event) => setSelected(event.target.checked ? new Set(shown.map((item) => item.id)) : new Set())}
          />
        </label>
        <span className="mg-admin-bulk-count">{chosen.length ? `${chosen.length}개 고름` : `${shown.length}개`}</span>
        {chosen.length > 0 && !narrow && actions}
      </div>
      {/* On a phone the choices sit in a tray above the bottom bar, where a thumb reaches them from anywhere in the list.
          It goes to <body>: the glass panel's backdrop filter would otherwise pin a fixed element to the panel. */}
      {chosen.length > 0 &&
        narrow &&
        createPortal(
          <div className="mg-admin-bulk-tray" role="region" aria-label="고른 항목 바꾸기">
            <span className="mg-admin-bulk-count">{chosen.length}개 고름</span>
            {actions}
          </div>,
          document.body,
        )}

      {items === null && <p className="mg-empty">카탈로그를 불러오는 중…</p>}
      {items !== null && shown.length === 0 && <p className="mg-empty">조건에 맞는 항목이 없어요</p>}
      {narrow ? (
        <ul className="mg-admin-item-cards">
          {shown.map((item) => (
            <ItemCard key={item.id} {...rowProps(item)} />
          ))}
        </ul>
      ) : (
        shown.length > 0 && (
          <div className="mg-table-wrap">
            <table className="mg-table mg-admin-table">
              <thead>
                <tr>
                  <th aria-label="고르기" />
                  <th aria-label="그림" />
                  <th>이름 · ID</th>
                  <th>이모지</th>
                  <th>순서</th>
                  <th>동작</th>
                  <th>출처</th>
                  <th>사용</th>
                  <th>상태</th>
                  <th aria-label="더 보기" />
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => (
                  <TableRow key={item.id} {...rowProps(item)} />
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
