import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Link, Navigate } from 'react-router-dom';

import { problemText } from '../api/client';
import { catalogApi } from '../api/endpoints';
import type { CatalogItem, CatalogStatus, FactoryCharacter } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { Loading } from './Loading';

const FACTORY_UI_URL = import.meta.env['VITE_FACTORY_UI_URL'] ?? 'http://127.0.0.1:5273';
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
    <form className="page-form" onSubmit={submit}>
      <label>
        카탈로그 ID
        <input name="id" required pattern="[a-z0-9][a-z0-9_\-]+" defaultValue={character.imported?.id ?? suggestedId(character)} />
      </label>
      <label>
        이름
        <input name="label" required maxLength={30} defaultValue={character.name.slice(0, 30)} />
      </label>
      <label>
        이모지
        <input name="emoji" required maxLength={16} defaultValue="🧑" />
      </label>
      <div className="page-actions">
        <button className="page-button" type="submit" disabled={busy}>
          {busy ? '가져오는 중…' : '가져오기'}
        </button>
        <button className="page-button page-button--ghost" type="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}

/** `/admin`: the character server's finished characters, copied into the 미니미 catalog and published from here. */
export function AdminPage() {
  const { status, user } = useAuth();
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [characters, setCharacters] = useState<FactoryCharacter[] | null>(null);
  const [factoryProblem, setFactoryProblem] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const isAdmin = user?.role === 'admin';

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

  return (
    <main className="page">
      <header className="page-header">
        <Link className="page-brand" to={`/@${user.username}`}>
          🏝️ 모개숲 관리
        </Link>
        <nav className="page-actions">
          <a className="page-button page-button--ghost" href={FACTORY_UI_URL} target="_blank" rel="noreferrer">
            캐릭터 스튜디오 열기
          </a>
        </nav>
      </header>

      {message && <p className="page-muted" role="status">{message}</p>}

      <section className="page-card">
        <div className="page-header">
          <h2>캐릭터 스튜디오의 완성 캐릭터</h2>
          <button
            className="page-button page-button--ghost"
            disabled={characters === null}
            onClick={() => {
              setCharacters(null);
              void reloadCharacters();
            }}
          >
            새로고침
          </button>
        </div>
        <p className="page-muted">
          가져오면 텍스처를 웹용으로 줄여 모개숲 저장소에 복사해요. 초안으로 들어오니 확인한 뒤 공개하세요.
        </p>
        {factoryProblem && <p className="page-error">{factoryProblem}</p>}
        {characters === null && <p className="page-muted">캐릭터 스튜디오에 묻는 중…</p>}
        {characters?.length === 0 && !factoryProblem && <p className="page-muted">완성된 캐릭터가 없어요</p>}
        <ul className="admin-characters">
          {characters?.map((character) => {
            const imported = character.imported;
            return (
              <li key={character.jobId} className="admin-character">
                <img src={character.thumbnailUrl} alt="" loading="lazy" />
                <b>{character.name}</b>
                <small>
                  {character.stage === 'complete' ? '완성' : '표정 준비 중'} · {dateOf(character.createdAt)}
                </small>
                {imported && (
                  <span className="admin-state">
                    {imported.current ? `${imported.id} · ${STATUS_LABEL[imported.status]}` : `${imported.id} · 새 조립본 있음`}
                  </span>
                )}
                {opened === character.jobId ? (
                  <ImportForm
                    character={character}
                    busy={busy === character.jobId}
                    onSubmit={(fields) => importCharacter(character, fields)}
                    onCancel={() => setOpened(null)}
                  />
                ) : (
                  <div className="page-actions">
                    {(!imported || !imported.current) && (
                      <button className="page-button" disabled={busy !== null} onClick={() => setOpened(character.jobId)}>
                        {imported ? '새 조립본 가져오기' : '가져오기'}
                      </button>
                    )}
                    {imported?.current && imported.status !== 'published' && (
                      <button
                        className="page-button"
                        disabled={busy !== null}
                        onClick={() => setStatus(imported.id, character.name, 'published')}
                      >
                        공개
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="page-card">
        <h2>미니미 카탈로그</h2>
        <table className="page-table">
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
                <td>{item.thumbnailUrl ? <img className="page-thumb" src={item.thumbnailUrl} alt="" /> : item.emoji}</td>
                <td>
                  <code>{item.id}</code>
                </td>
                <td>{item.label}</td>
                <td>{item.clips.join(' · ')}</td>
                <td>{item.source === 'factory' ? '캐릭터 스튜디오' : '기본'}</td>
                <td>{STATUS_LABEL[item.status]}</td>
                <td className="page-actions">
                  {(['published', 'retired'] as const)
                    .filter((next) => next !== item.status)
                    .map((next) => (
                      <button
                        key={next}
                        className="page-button page-button--ghost"
                        disabled={busy !== null}
                        onClick={() => setStatus(item.id, item.label, next)}
                      >
                        {next === 'published' ? '공개' : '내리기'}
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
