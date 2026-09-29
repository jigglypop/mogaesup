import { useState, type FormEvent } from 'react';

import type { AdminCatalogItem, CatalogImport, CatalogStatus, FactoryCharacter } from '../../api/types';
import { Icon } from '../../ui/icons';
import {
  CATALOG_ID,
  CHARACTER_FILTERS,
  FRESHNESS_LABEL,
  SOURCE_LABEL,
  STAGE_LABEL,
  STATUS_LABEL,
  activeImportFor,
  characterGroup,
  countGroups,
  faceText,
  filterCharacters,
  formatWhen,
  suggestedId,
  textProblem,
  type CharacterFilter,
} from './catalogView';
import { ImportProgress, ThumbButton } from './parts';
import type { PreviewTarget } from './PreviewDialog';

/** What the import form sends: a new item's id, name and emoji, or an existing item's to update it. */
export type ImportFields = { id: string; label: string; emoji: string };

type ImportFormProps = {
  character: FactoryCharacter;
  onSubmit: (fields: ImportFields) => Promise<boolean>;
  onCancel: () => void;
};

function ImportForm({ character, onSubmit, onCancel }: ImportFormProps) {
  const imported = character.imported;
  const [mode, setMode] = useState<'update' | 'new'>(imported ? 'update' : 'new');
  const [problem, setProblem] = useState('');
  const [sending, setSending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (key: string) => String(form.get(key) ?? '').trim();
    const fields =
      mode === 'update' && imported
        ? { id: imported.id, label: imported.label, emoji: imported.emoji }
        : { id: field('id'), label: field('label'), emoji: field('emoji') };
    const issue = !CATALOG_ID.test(fields.id)
      ? '카탈로그 ID는 영문 소문자·숫자·밑줄·하이픈 2~64자예요'
      : (textProblem(fields.label, 30) ?? textProblem(fields.emoji, 16));
    if (issue) return setProblem(issue);
    setSending(true);
    const ok = await onSubmit(fields);
    setSending(false);
    if (!ok) setProblem('가져오기를 시작하지 못했어요. 위 안내를 확인해 주세요.');
  };
  return (
    <form className="mg-admin-form" onSubmit={(event) => void submit(event)}>
      {imported && (
        <div className="mg-tabs is-fit mg-admin-seg" role="radiogroup" aria-label="가져올 곳">
          <button type="button" role="radio" aria-checked={mode === 'update'} onClick={() => setMode('update')}>
            {imported.id} 업데이트
          </button>
          <button type="button" role="radio" aria-checked={mode === 'new'} onClick={() => setMode('new')}>
            새 항목으로
          </button>
        </div>
      )}
      {mode === 'update' && imported ? (
        <p className="mg-admin-fineprint">
          모델·대표 그림·애니메이션만 새로 바뀌어요. 공개 상태·이름·이모지·순서는 그대로 두고, 지금 모델은 버전 기록에 남아 언제든 되돌릴 수 있어요.
        </p>
      ) : (
        <>
          <label className="mg-label">
            카탈로그 ID
            <input className="mg-field" name="id" required pattern="[a-z0-9][a-z0-9_\-]{1,63}" defaultValue={suggestedId(character)} autoCapitalize="off" spellCheck={false} />
          </label>
          <label className="mg-label">
            이름
            <input className="mg-field" name="label" required maxLength={30} defaultValue={character.name.slice(0, 30)} />
          </label>
          <label className="mg-label">
            이모지
            <input className="mg-field" name="emoji" required maxLength={16} defaultValue="🧑" />
          </label>
        </>
      )}
      {problem && (
        <p className="mg-error" role="alert">
          {problem}
        </p>
      )}
      <div className="mg-admin-actions">
        <button className="mg-btn is-quiet is-small" type="button" onClick={onCancel}>
          취소
        </button>
        <button className="mg-btn is-primary is-small" type="submit" disabled={sending}>
          {sending ? '보내는 중…' : mode === 'update' ? '업데이트 시작' : '가져오기 시작'}
        </button>
      </div>
    </form>
  );
}

function CharacterCard({
  character,
  running,
  onImport,
  onPreview,
}: {
  character: FactoryCharacter;
  running: CatalogImport | undefined;
  onImport: (character: FactoryCharacter, fields: ImportFields) => Promise<boolean>;
  onPreview: (target: PreviewTarget) => void;
}) {
  const [form, setForm] = useState(false);
  const imported = character.imported;
  const group = characterGroup(character);
  const preview = () =>
    onPreview({
      title: character.name,
      url: character.modelUrl,
      note: `가져오면 복사할 모델이에요 (${character.sourceRef}).`,
    });
  return (
    <article className={`mg-admin-card${group === 'update' ? ' is-update' : ''}`}>
      <div className="mg-admin-card-main">
        <ThumbButton src={character.thumbnailUrl} fallback="🧑" label={character.name} onClick={preview} />
        <div>
          <b>{character.name}</b>
          <small>
            {STAGE_LABEL[character.stage]} · {faceText(character)}
            {character.createdAt ? ` · ${formatWhen(character.createdAt)}` : ''}
          </small>
          {imported ? (
            <small className={imported.current ? 'mg-admin-good' : 'mg-warn-text'}>
              <code>{imported.id}</code> · {STATUS_LABEL[imported.status]} ·{' '}
              {imported.current ? '최신' : `새 버전 있음 — ${FRESHNESS_LABEL[imported.freshness]}`}
            </small>
          ) : (
            <small>아직 가져오지 않았어요</small>
          )}
          {character.otherItems.length > 0 && <small>같은 캐릭터 항목: {character.otherItems.join(', ')}</small>}
        </div>
      </div>
      {running ? (
        <ImportProgress item={running} compact />
      ) : form ? (
        <ImportForm
          character={character}
          onCancel={() => setForm(false)}
          onSubmit={async (fields) => {
            const ok = await onImport(character, fields);
            if (ok) setForm(false);
            return ok;
          }}
        />
      ) : (
        <div className="mg-admin-actions">
          <button type="button" className="mg-btn is-quiet is-small" onClick={preview}>
            <Icon name="eye" /> 3D 보기
          </button>
          <button type="button" className={`mg-btn is-small${group === 'current' ? '' : ' is-primary'}`} onClick={() => setForm(true)}>
            {group === 'new' ? '가져오기' : group === 'update' ? '업데이트' : '다시 가져오기'}
          </button>
        </div>
      )}
    </article>
  );
}

type BoardProps = {
  characters: FactoryCharacter[] | null;
  factoryProblem: string;
  items: AdminCatalogItem[] | null;
  imports: CatalogImport[];
  busy: ReadonlySet<string>;
  onImport: (character: FactoryCharacter, fields: ImportFields) => Promise<boolean>;
  onStatus: (item: AdminCatalogItem, next: CatalogStatus) => void;
  onPreview: (target: PreviewTarget) => void;
  onVersions: (item: AdminCatalogItem) => void;
};

/** `/admin`: finished studio characters become drafts, and drafts go public, one column each. */
export function PipelineBoard({ characters, factoryProblem, items, imports, busy, onImport, onStatus, onPreview, onVersions }: BoardProps) {
  const [filter, setFilter] = useState<CharacterFilter>('todo');
  const [query, setQuery] = useState('');
  const counts = countGroups(characters ?? []);
  const shown = filterCharacters(characters ?? [], filter, query);
  const drafts = (items ?? []).filter((item) => item.status === 'draft');
  const published = (items ?? []).filter((item) => item.status === 'published');
  const preview = (item: AdminCatalogItem) => onPreview({ title: item.label, url: item.modelUrl });

  return (
    <div className="mg-board">
      <section className="mg-column mg-card" aria-label="스튜디오 완성">
        <header>
          <b>스튜디오 완성</b>
          <span>{counts.todo ? `할 일 ${counts.todo}` : characters === null ? '' : '모두 최신'}</span>
        </header>
        <input
          className="mg-field mg-admin-search"
          type="search"
          value={query}
          placeholder="이름·작업·항목 ID로 찾기"
          aria-label="스튜디오 캐릭터 찾기"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="mg-tabs is-fit mg-admin-seg" role="group" aria-label="보기">
          {CHARACTER_FILTERS.map((option) => (
            <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>
              {option.label} {counts[option.value]}
            </button>
          ))}
        </div>
        {factoryProblem && (
          <p className="mg-error" role="alert">
            {factoryProblem}
          </p>
        )}
        {characters === null && <p className="mg-empty">캐릭터 스튜디오에 묻는 중…</p>}
        {characters !== null && shown.length === 0 && !factoryProblem && (
          <p className="mg-empty">{query ? '찾는 캐릭터가 없어요' : filter === 'todo' ? '새로 가져올 캐릭터가 없어요' : '이 보기에는 캐릭터가 없어요'}</p>
        )}
        {shown.map((character) => (
          <CharacterCard
            key={character.jobId}
            character={character}
            running={activeImportFor(imports, { jobId: character.jobId, characterId: character.characterId, itemId: character.imported?.id })}
            onImport={onImport}
            onPreview={onPreview}
          />
        ))}
      </section>

      <section className="mg-column mg-card" aria-label="초안">
        <header>
          <b>초안</b>
          <span>{drafts.length}</span>
        </header>
        {items !== null && drafts.length === 0 && <p className="mg-empty">확인할 초안이 없어요</p>}
        {drafts.map((item) => {
          const running = activeImportFor(imports, { itemId: item.id });
          return (
            <article key={item.id} className="mg-admin-card is-draft">
              <div className="mg-admin-card-main">
                <ThumbButton src={item.thumbnailUrl} fallback={item.emoji} label={item.label} onClick={() => preview(item)} />
                <div>
                  <b>{item.label}</b>
                  <small>
                    <code>{item.id}</code> · 버전 {item.versionCount}
                  </small>
                </div>
              </div>
              <div className="mg-clips">
                {item.clips.map((clip) => (
                  <span key={clip} className="mg-badge">
                    {clip}
                  </span>
                ))}
              </div>
              {running && <ImportProgress item={running} compact />}
              <div className="mg-admin-actions">
                <button type="button" className="mg-btn is-quiet is-small" onClick={() => preview(item)}>
                  <Icon name="eye" /> 3D 보기
                </button>
                {item.versionCount > 0 && (
                  <button type="button" className="mg-btn is-quiet is-small" onClick={() => onVersions(item)}>
                    기록
                  </button>
                )}
                <button type="button" className="mg-btn is-primary is-small" disabled={busy.has(item.id)} onClick={() => onStatus(item, 'published')}>
                  공개
                </button>
              </div>
            </article>
          );
        })}
      </section>

      <section className="mg-column mg-card" aria-label="공개">
        <header>
          <b>공개</b>
          <span>{published.length}</span>
        </header>
        {published.map((item) => (
          <article key={item.id} className="mg-admin-card is-row">
            <ThumbButton src={item.thumbnailUrl} fallback={item.emoji} label={item.label} onClick={() => preview(item)} />
            <div>
              <b>{item.label}</b>
              <small>
                {SOURCE_LABEL[item.source]} · {item.kind === 'minime' ? `섬 ${item.usage.toLocaleString('ko-KR')}곳에서 사용` : '가구'}
              </small>
              {activeImportFor(imports, { itemId: item.id }) && <small className="mg-warn-text">새 모델을 가져오는 중</small>}
            </div>
            <button type="button" className="mg-btn is-small" disabled={busy.has(item.id)} onClick={() => onStatus(item, 'retired')}>
              내리기
            </button>
          </article>
        ))}
      </section>
    </div>
  );
}
