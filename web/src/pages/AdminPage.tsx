import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Link, Navigate } from 'react-router-dom';

import { problemText } from '../api/client';
import { catalogApi } from '../api/endpoints';
import type { CatalogItem, CatalogStatus } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { Loading } from './Loading';

const FACTORY_UI_URL = import.meta.env['VITE_FACTORY_UI_URL'] ?? 'http://127.0.0.1:5273';
const STATUS_LABEL: Record<CatalogStatus, string> = { draft: '초안', published: '공개', retired: '내림' };

/** `/admin`: the 미니미 catalog, and publishing character-server assemblies into it. */
export function AdminPage() {
  const { status, user } = useAuth();
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === 'admin';

  const reload = useCallback(() => catalogApi.adminItems().then((result) => setItems(result.items)), []);
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      await reload();
      setMessage(done);
    } catch (problem) {
      setMessage(problemText(problem));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (isAdmin) reload().catch(() => setMessage('카탈로그를 불러오지 못했어요'));
  }, [isAdmin, reload]);

  if (status === 'loading') return <Loading />;
  if (!user) return <Navigate to="/" replace />;
  if (!isAdmin) return <Navigate to={`/@${user.username}`} replace />;

  const importFactory = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (key: string) => String(form.get(key) ?? '').trim();
    run(
      () =>
        catalogApi.importFactory({
          id: field('id'),
          kind: 'minime',
          label: field('label'),
          emoji: field('emoji'),
          factoryJobId: field('factoryJobId'),
          factoryVersion: field('factoryVersion'),
        }),
      '가져왔어요. 확인한 뒤 공개하세요.',
    );
  };

  return (
    <main className="page">
      <header className="page-header">
        <Link className="page-brand" to={`/@${user.username}`}>
          🏝️ 모개숲 관리
        </Link>
        <nav className="page-actions">
          <a className="page-button page-button--ghost" href={FACTORY_UI_URL} target="_blank" rel="noreferrer">
            에셋 공장 열기
          </a>
        </nav>
      </header>

      <section className="page-card">
        <h2>에셋 공장 캐릭터 가져오기</h2>
        <form className="page-form page-form--row" onSubmit={importFactory}>
          <label>
            작업 ID
            <input name="factoryJobId" required pattern="[A-Za-z0-9_\-]+" />
          </label>
          <label>
            조립 버전
            <input name="factoryVersion" required pattern="[A-Za-z0-9._\-]+" />
          </label>
          <label>
            카탈로그 ID
            <input name="id" required pattern="[a-z0-9][a-z0-9_\-]+" />
          </label>
          <label>
            이름
            <input name="label" required maxLength={30} />
          </label>
          <label>
            이모지
            <input name="emoji" required maxLength={16} defaultValue="🧑" />
          </label>
          <button className="page-button" type="submit" disabled={busy}>
            가져오기
          </button>
        </form>
        {message && <p className="page-muted">{message}</p>}
      </section>

      <section className="page-card">
        <h2>미니미 카탈로그</h2>
        <table className="page-table">
          <thead>
            <tr>
              <th />
              <th>ID</th>
              <th>이름</th>
              <th>출처</th>
              <th>상태</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.emoji}</td>
                <td>
                  <code>{item.id}</code>
                </td>
                <td>{item.label}</td>
                <td>{item.source === 'factory' ? `공장 ${item.sourceRef ?? ''}` : '기본'}</td>
                <td>{STATUS_LABEL[item.status]}</td>
                <td className="page-actions">
                  {(['published', 'retired'] as const)
                    .filter((next) => next !== item.status)
                    .map((next) => (
                      <button
                        key={next}
                        className="page-button page-button--ghost"
                        disabled={busy}
                        onClick={() =>
                          run(() => catalogApi.patch(item.id, { status: next }), `${item.label}: ${STATUS_LABEL[next]}`)
                        }
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
