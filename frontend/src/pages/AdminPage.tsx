import './admin/admin.css';

import { useCallback, useEffect, useState } from 'react';

import { Link, Navigate, useLocation } from 'react-router-dom';

import { problemText } from '../api/client';
import { catalogApi } from '../api/endpoints';
import type { AdminCatalogItem, CatalogChanges, CatalogImport, CatalogKind, CatalogStatus, FactoryCharacter } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { PageShell } from '../shell/Shell';
import { Icon } from '../ui/icons';
import { CatalogTable } from './admin/CatalogTable';
import { STATUS_LABEL, outcomeText, retireWarning } from './admin/catalogView';
import { useImportQueue } from './admin/hooks';
import { ImportPanel } from './admin/ImportPanel';
import { PipelineBoard, type ImportFields } from './admin/PipelineBoard';
import { PreviewDialog, type PreviewTarget } from './admin/PreviewDialog';
import { VersionsDialog } from './admin/VersionsDialog';
import { Loading } from './Loading';

const TABS = [
  { to: '/admin', label: '캐릭터 가져오기' },
  { to: '/admin/catalog', label: '카탈로그' },
  { to: '/studio/library', label: '에셋 라이브러리' },
];

type Notice = { tone: 'ok' | 'error'; text: string };

/**
 * `/admin`: characters finished in the studio are copied into the 미니미 catalog in the background, checked and kept
 * as versions, then go public; `/admin/catalog` edits every item.
 */
export function AdminPage() {
  const { status, user } = useAuth();
  const { pathname } = useLocation();
  const isAdmin = user?.role === 'admin';
  const catalogTab = pathname.startsWith('/admin/catalog');
  const [items, setItems] = useState<AdminCatalogItem[] | null>(null);
  const [characters, setCharacters] = useState<FactoryCharacter[] | null>(null);
  const [factoryProblem, setFactoryProblem] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [versionsOf, setVersionsOf] = useState<AdminCatalogItem | null>(null);

  const reloadItems = useCallback(
    () =>
      catalogApi.adminItems().then(
        (result) => setItems(result.items),
        (problem: unknown) => setNotice({ tone: 'error', text: `카탈로그를 불러오지 못했어요: ${problemText(problem)}` }),
      ),
    [],
  );
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

  const onFinished = useCallback(
    (ended: CatalogImport[]) => {
      void reloadItems();
      void reloadCharacters();
      const failed = ended.filter((item) => item.status === 'failed');
      const [only] = ended;
      if (ended.length === 1 && only) {
        setNotice({ tone: only.status === 'failed' ? 'error' : 'ok', text: `${only.label}: ${outcomeText(only)}` });
      } else {
        const text = `가져오기 ${ended.length}건이 끝났어요${failed.length ? ` (실패 ${failed.length}건)` : ''}`;
        setNotice({ tone: failed.length ? 'error' : 'ok', text });
      }
    },
    [reloadItems, reloadCharacters],
  );
  const queue = useImportQueue(isAdmin, onFinished);

  useEffect(() => {
    if (!isAdmin) return;
    void reloadItems();
    void reloadCharacters();
  }, [isAdmin, reloadItems, reloadCharacters]);

  if (status === 'loading') return <Loading />;
  if (!user) return <Navigate to="/" replace />;
  if (!isAdmin) return <Navigate to={`/@${user.username}`} replace />;

  const mark = (keys: string[], on: boolean) =>
    setBusy((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  /** Runs one change with only the rows it touches locked; the rest of the page keeps working. */
  const withBusy = async (keys: string[], action: () => Promise<void>) => {
    mark(keys, true);
    try {
      await action();
      return true;
    } catch (problem) {
      setNotice({ tone: 'error', text: problemText(problem) });
      return false;
    } finally {
      mark(keys, false);
    }
  };
  const replace = (changed: AdminCatalogItem[]) =>
    setItems((previous) => previous && previous.map((item) => changed.find((next) => next.id === item.id) ?? item));

  const patch = (item: AdminCatalogItem, changes: CatalogChanges) =>
    withBusy([item.id], async () => {
      const updated = await catalogApi.patch(item.id, changes);
      replace([updated]);
      setNotice({ tone: 'ok', text: changes.status ? `${updated.label}: ${STATUS_LABEL[updated.status]}` : `${updated.label}: 저장했어요` });
    });

  const setStatus = (item: AdminCatalogItem, next: CatalogStatus) => {
    if (next === item.status) return;
    const warning = item.status === 'published' ? retireWarning([item]) : null;
    if (warning && !window.confirm(warning)) return;
    void patch(item, { status: next }).then((ok) => {
      if (ok) void reloadCharacters();
    });
  };

  const bulk = async (chosen: AdminCatalogItem[], next: CatalogStatus) => {
    const warning = next === 'published' ? null : retireWarning(chosen.filter((item) => item.status === 'published'));
    if (warning && !window.confirm(warning)) return false;
    const ids = chosen.map((item) => item.id);
    return withBusy(['bulk', ...ids], async () => {
      const result = await catalogApi.bulkStatus(ids, next);
      replace(result.items);
      setNotice({ tone: 'ok', text: `${ids.length}개를 ${STATUS_LABEL[next]}(으)로 바꿨어요` });
      void reloadCharacters();
    });
  };

  const startImport = async (fields: ImportFields & { kind: CatalogKind; factoryJobId: string }) => {
    try {
      await queue.start(fields);
      setNotice({ tone: 'ok', text: `${fields.label}: 가져오기를 시작했어요. 다른 일을 해도 뒤에서 계속돼요.` });
      return true;
    } catch (problem) {
      setNotice({ tone: 'error', text: problemText(problem) });
      return false;
    }
  };

  const refreshAll = () => {
    setCharacters(null);
    void reloadItems();
    void reloadCharacters();
    void queue.refresh();
  };

  return (
    <PageShell title="운영" wide>
      <section className="mg-glass mg-panel mg-admin">
        <div className="mg-panel-head">
          <h1 className="mg-title">운영</h1>
          <nav className="mg-tabs is-fit mg-admin-tabs" aria-label="운영">
            {TABS.map((tab) => (
              <Link key={tab.to} to={tab.to} aria-current={(tab.to === '/admin/catalog') === catalogTab && tab.to.startsWith('/admin') ? 'page' : undefined}>
                {tab.label}
              </Link>
            ))}
          </nav>
          <button className="mg-btn is-small" disabled={characters === null && !catalogTab} onClick={refreshAll}>
            <Icon name="rotate" /> 새로고침
          </button>
        </div>
        {notice && (
          <div className={`mg-admin-message${notice.tone === 'error' ? ' is-error' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
            <span>{notice.text}</span>
            <button type="button" className="mg-icon-btn is-quiet" aria-label="알림 닫기" onClick={() => setNotice(null)}>
              <Icon name="close" />
            </button>
          </div>
        )}

        {catalogTab ? (
          <CatalogTable
            items={items}
            imports={queue.imports ?? []}
            busy={busy}
            onPatch={patch}
            onStatus={setStatus}
            onBulk={bulk}
            onPreview={setPreview}
            onVersions={setVersionsOf}
          />
        ) : (
          <>
            <ImportPanel
              imports={queue.imports}
              problem={queue.problem}
              onRetry={(item) =>
                void startImport({ id: item.itemId, kind: item.kind, label: item.label, emoji: item.emoji, factoryJobId: item.factoryJobId })
              }
            />
            <PipelineBoard
              characters={characters}
              factoryProblem={factoryProblem}
              items={items}
              imports={queue.imports ?? []}
              busy={busy}
              onImport={(character, fields) => startImport({ ...fields, kind: 'minime', factoryJobId: character.jobId })}
              onStatus={setStatus}
              onPreview={setPreview}
              onVersions={setVersionsOf}
            />
          </>
        )}
      </section>
      {versionsOf && (
        <VersionsDialog
          item={versionsOf}
          onClose={() => setVersionsOf(null)}
          onPreview={setPreview}
          onRolledBack={(updated) => {
            replace([updated]);
            void reloadCharacters();
            setNotice({ tone: 'ok', text: `${updated.label}: 예전 버전으로 되돌렸어요` });
          }}
        />
      )}
      {preview && <PreviewDialog target={preview} onClose={() => setPreview(null)} />}
    </PageShell>
  );
}
