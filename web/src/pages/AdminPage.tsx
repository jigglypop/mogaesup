import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Link, Navigate, useLocation } from 'react-router-dom';

import { problemText } from '../api/client';
import { catalogApi } from '../api/endpoints';
import type { CatalogItem, CatalogStatus, FactoryCharacter } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { PageShell } from '../shell/Shell';
import { Icon } from '../ui/icons';
import { Loading } from './Loading';

const STATUS_LABEL: Record<CatalogStatus, string> = { draft: '초안', published: '공개', retired: '내림' };

/** Catalog ids are lowercase slugs; a character's job id gives it a stable one. */
const suggestedId = (character: FactoryCharacter) => `char-${character.jobId.slice(0, 8).toLowerCase()}`;
const dateOf = (at: string | null) => (at ? new Date(at).toLocaleDateString('ko-KR') : '');

type ImportFormProps = {
  character: FactoryCharacter;
  busy: boolean;
  onSubmit: (fields: { id: string; label: string; emoji: string }) => void;
  onCancel: () => void;
};

function ImportForm({ character, busy, onSubmit, onCancel }: ImportFormProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (key: string) => String(form.get(key) ?? '').trim();
    onSubmit({ id: field('id'), label: field('label'), emoji: field('emoji') });
  };
  return (
    <form className="mg-import-form" onSubmit={submit}>
      <label className="mg-label">
        카탈로그 ID
        <input className="mg-field" name="id" required pattern="[a-z0-9][a-z0-9_\-]+" defaultValue={character.imported?.id ?? suggestedId(character)} />
      </label>
      <label className="mg-label">
        이름
        <input className="mg-field" name="label" required maxLength={30} defaultValue={character.name.slice(0, 30)} />
      </label>
      <label className="mg-label">
        이모지
        <input className="mg-field" name="emoji" required maxLength={16} defaultValue="🧑" />
      </label>
      <div className="mg-row-end">
        <button className="mg-btn is-quiet is-small" type="button" onClick={onCancel}>
          취소
        </button>
        <button className="mg-btn is-primary is-small" type="submit" disabled={busy}>
          {busy ? '가져오는 중…' : '가져오기'}
        </button>
      </div>
    </form>
  );
}

const TABS = [
  { to: '/admin', label: '캐릭터 가져오기' },
  { to: '/admin/catalog', label: '카탈로그' },
  { to: '/studio/library', label: '에셋 라이브러리' },
];

function Thumb({ src, fallback }: { src: string | null; fallback: string }) {
  return <span className="mg-admin-thumb">{src ? <img src={src} alt="" loading="lazy" /> : <span aria-hidden="true">{fallback}</span>}</span>;
}

/** `/admin`: characters finished in the studio move to the 미니미 catalog as drafts, then go public from here. */
export function AdminPage() {
  const { status, user } = useAuth();
  const { pathname } = useLocation();
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [characters, setCharacters] = useState<FactoryCharacter[] | null>(null);
  const [factoryProblem, setFactoryProblem] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const isAdmin = user?.role === 'admin';
  const catalogTab = pathname.startsWith('/admin/catalog');

  const reloadItems = useCallback(() => catalogApi.adminItems().then((result) => setItems(result.items)), []);
  const reloadCharacters = useCallback(
    () =>
      catalogApi.factoryCharacters().then(
        (result) => {
          setCharacters(result.characters);
          setFactoryProblem('');
        },
        (problem: unknown) => {
          setCharacters([]);
          setFactoryProblem(problemText(problem));
        },
      ),
    [],
  );

  useEffect(() => {
    if (!isAdmin) return;
    reloadItems().catch(() => setMessage('카탈로그를 불러오지 못했어요'));
    void reloadCharacters();
  }, [isAdmin, reloadItems, reloadCharacters]);

  const run = async (key: string, action: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setMessage('');
    try {
      await action();
      await Promise.all([reloadItems(), reloadCharacters()]);
      setMessage(done);
      return true;
    } catch (problem) {
      setMessage(problemText(problem));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (status === 'loading') return <Loading />;
  if (!user) return <Navigate to="/" replace />;
  if (!isAdmin) return <Navigate to={`/@${user.username}`} replace />;

  const importCharacter = (character: FactoryCharacter, fields: { id: string; label: string; emoji: string }) => {
    void run(
      character.jobId,
      () => catalogApi.importFactory({ ...fields, kind: 'minime', factoryJobId: character.jobId }),
      `${fields.label}: 가져왔어요. 확인한 뒤 공개하세요.`,
    ).then((ok) => ok && setOpened(null));
  };
  const setStatus = (id: string, label: string, next: CatalogStatus) =>
    void run(id, () => catalogApi.patch(id, { status: next }), `${label}: ${STATUS_LABEL[next]}`);

  const waiting = (characters ?? []).filter((character) => !character.imported?.current);
  const drafts = items.filter((item) => item.status === 'draft');
  const published = items.filter((item) => item.status === 'published');

  return (
    <PageShell title="운영" wide>
      <section className="mg-glass mg-panel mg-admin">
        <div className="mg-panel-head">
          <h1 className="mg-title">운영</h1>
          <nav className="mg-tabs is-fit" aria-label="운영">
            {TABS.map((tab) => (
              <Link key={tab.to} to={tab.to} aria-current={(tab.to === '/admin/catalog') === catalogTab && tab.to.startsWith('/admin') ? 'page' : undefined}>
                {tab.label}
              </Link>
            ))}
          </nav>
          {!catalogTab && (
            <button
              className="mg-btn is-small"
              disabled={characters === null}
              onClick={() => {
                setCharacters(null);
                void reloadCharacters();
              }}
            >
              <Icon name="rotate" /> 새로고침
            </button>
          )}
        </div>
        {message && (
          <p className="mg-admin-message" role="status">
            {message}
          </p>
        )}

        {catalogTab ? (
          <div className="mg-table-wrap">
            <table className="mg-table">
              <thead>
                <tr>
                  <th />
                  <th>ID</th>
                  <th>이름</th>
                  <th>동작</th>
                  <th>출처</th>
                  <th>상태</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Thumb src={item.thumbnailUrl} fallback={item.emoji} />
                    </td>
                    <td>
                      <code>{item.id}</code>
                    </td>
                    <td>{item.label}</td>
                    <td className="mg-muted">{item.clips.join(' · ')}</td>
                    <td>{item.source === 'factory' ? '캐릭터 스튜디오' : '기본'}</td>
                    <td>
                      <span className={`mg-badge is-${item.status}`}>{STATUS_LABEL[item.status]}</span>
                    </td>
                    <td className="mg-row-end">
                      {(['published', 'retired'] as const)
                        .filter((next) => next !== item.status)
                        .map((next) => (
                          <button key={next} className="mg-btn is-small" disabled={busy !== null} onClick={() => setStatus(item.id, item.label, next)}>
                            {next === 'published' ? '공개' : '내리기'}
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mg-board">
            <section className="mg-column mg-card" aria-label="스튜디오 완성">
              <header>
                <b>스튜디오 완성</b>
                <span>{waiting.length}</span>
              </header>
              {factoryProblem && <p className="mg-error">{factoryProblem}</p>}
              {characters === null && <p className="mg-empty">캐릭터 스튜디오에 묻는 중…</p>}
              {characters !== null && waiting.length === 0 && !factoryProblem && <p className="mg-empty">새로 가져올 캐릭터가 없어요</p>}
              {waiting.map((character) => (
                <article key={character.jobId} className="mg-admin-card">
                  <div className="mg-admin-card-main">
                    <Thumb src={character.thumbnailUrl} fallback="🧑" />
                    <div>
                      <b>{character.name}</b>
                      <small>
                        {character.stage === 'complete' ? '완성 · 표정 적용됨' : '표정 준비 중 · 기본 조립본만 있음'} · {dateOf(character.createdAt)}
                      </small>
                      {character.imported && <small className="mg-warn-text">{character.imported.id} · 새 조립본 있음</small>}
                    </div>
                  </div>
                  {opened === character.jobId ? (
                    <ImportForm
                      character={character}
                      busy={busy === character.jobId}
                      onSubmit={(fields) => importCharacter(character, fields)}
                      onCancel={() => setOpened(null)}
                    />
                  ) : (
                    <button className="mg-btn is-primary is-small" disabled={busy !== null} onClick={() => setOpened(character.jobId)}>
                      {character.imported ? '새 조립본 가져오기' : '가져오기'}
                    </button>
                  )}
                </article>
              ))}
            </section>

            <section className="mg-column mg-card" aria-label="초안">
              <header>
                <b>초안</b>
                <span>{drafts.length}</span>
              </header>
              {drafts.length === 0 && <p className="mg-empty">확인할 초안이 없어요</p>}
              {drafts.map((item) => (
                <article key={item.id} className="mg-admin-card is-draft">
                  <div className="mg-admin-card-main">
                    <Thumb src={item.thumbnailUrl} fallback={item.emoji} />
                    <div>
                      <b>{item.label}</b>
                      <small>
                        <code>{item.id}</code>
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
                  <button className="mg-btn is-primary is-small" disabled={busy !== null} onClick={() => setStatus(item.id, item.label, 'published')}>
                    공개
                  </button>
                </article>
              ))}
            </section>

            <section className="mg-column mg-card" aria-label="공개">
              <header>
                <b>공개</b>
                <span>{published.length}</span>
              </header>
              {published.map((item) => (
                <article key={item.id} className="mg-admin-card is-row">
                  <Thumb src={item.thumbnailUrl} fallback={item.emoji} />
                  <div>
                    <b>{item.label}</b>
                    <small>{item.source === 'factory' ? '캐릭터 스튜디오' : '기본'}</small>
                  </div>
                  <button className="mg-btn is-small" disabled={busy !== null} onClick={() => setStatus(item.id, item.label, 'retired')}>
                    내리기
                  </button>
                </article>
              ))}
            </section>
          </div>
        )}
      </section>
    </PageShell>
  );
}
