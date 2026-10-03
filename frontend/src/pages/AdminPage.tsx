import './admin/admin.css';

import { useCallback, useEffect, useState } from 'react';

import { Navigate, useLocation } from 'react-router-dom';

import { ApiRequestError, problemText } from '../api/client';
import { catalogApi } from '../api/endpoints';
import { WAKE_RETRY_MS, isStudioAsleep, type StudioSleep } from '../api/studioSleep';
import type { AdminCatalogItem, CatalogChanges, CatalogImport, CatalogKind, CatalogStatus, FactoryCharacter } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/can';
import { SignInRedirect } from '../auth/signIn';
import { PageShell } from '../shell/Shell';
import { StudioPowerLine, WakeBanner, useEvery } from '../studio/StudioPower';
import { Icon } from '../ui/icons';
import { CatalogTable } from './admin/CatalogTable';
import { STATUS_LABEL, outcomeText, retireWarning } from './admin/catalogView';
import { useImportQueue } from './admin/hooks';
import { ImportPanel } from './admin/ImportPanel';
import { PipelineBoard, type ImportFields } from './admin/PipelineBoard';
import { PreviewDialog, type PreviewTarget } from './admin/PreviewDialog';
import { VersionsDialog } from './admin/VersionsDialog';
import { AdminTabs } from './AdminTabs';
import { Loading } from './Loading';

type Notice = { tone: 'ok' | 'error'; text: string };

/**
 * `/admin`: characters finished in the studio are copied into the 미니미 catalog in the background, checked and kept
 * as versions, then go public; `/admin/catalog` edits every item.
 */
export function AdminPage() {
  const { status, user } = useAuth();
  const { pathname } = useLocation();
  // Catalog editors (moderators and admins included) run this page.
  const isAdmin = can(user, 'catalog_editor');
  const catalogTab = pathname.startsWith('/admin/catalog');
  const [items, setItems] = useState<AdminCatalogItem[] | null>(null);
  /** Why the catalog did not load; `items` stays null meanwhile, which is not the same as still loading. */
  const [itemsProblem, setItemsProblem] = useState('');
  const [characters, setCharacters] = useState<FactoryCharacter[] | null>(null);
  const [factoryProblem, setFactoryProblem] = useState('');
  /** Set while the studio's instance starts (or stops); the listing is asked again every 10 s until it answers. */
  const [asleep, setAsleep] = useState<StudioSleep | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [versionsOf, setVersionsOf] = useState<AdminCatalogItem | null>(null);

  const reloadItems = useCallback(
    () =>
      catalogApi.adminItems().then(
        (result) => {
          setItems(result.items);
          setItemsProblem('');
        },
        (problem: unknown) => setItemsProblem(`카탈로그를 불러오지 못했어요: ${problemText(problem)}`),
      ),
    [],
  );
  const retryItems = () => {
    setItemsProblem('');
    void reloadItems();
  };
  const reloadCharacters = useCallback(
    () =>
      catalogApi.factoryCharacters().then(
        (result) => {
          setCharacters(result.characters);
          setFactoryProblem('');
          setAsleep(null);
        },
        (problem: unknown) => {
          if (problem instanceof ApiRequestError && isStudioAsleep(problem.code)) {
            const { code, message } = problem;
            setAsleep((previous) => ({ code, message, since: previous?.since ?? Date.now() }));
            setCharacters(null);
            setFactoryProblem('');
            return;
          }
          setAsleep(null);
          setCharacters([]);
          setFactoryProblem(problemText(problem));
        },
      ),
    [],
  );
  useEvery(asleep && isAdmin ? WAKE_RETRY_MS : null, reloadCharacters);

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
  if (!user) return <SignInRedirect />;
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
          <AdminTabs />
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

        {asleep && !catalogTab ? (
          <WakeBanner sleep={asleep} inline />
        ) : (
          <StudioPowerLine quietWhenRunning canStart={can(user, 'operator')} onRunning={() => void reloadCharacters()} />
        )}

        {catalogTab ? (
          <CatalogTable
            items={items}
            problem={itemsProblem}
            onRetry={retryItems}
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
              itemsProblem={itemsProblem}
              onRetryItems={retryItems}
              imports={queue.imports ?? []}
              busy={busy}
              onImport={(character, fields) => startImport({ ...fields, factoryJobId: character.jobId })}
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
