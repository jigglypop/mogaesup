import { useCallback, useEffect, useState } from 'react';

import { problemText } from '../../api/client';
import { catalogApi } from '../../api/endpoints';
import type { AdminCatalogItem, CatalogVersion } from '../../api/types';
import { formatWhen } from './catalogView';
import { Dialog } from './Dialog';
import { ReportBadges, Thumb } from './parts';
import type { PreviewTarget } from './PreviewDialog';
import { ReportView } from './ReportView';

/** Every model an item has shown, with each import's report; any earlier one can be put back. */
export function VersionsDialog({
  item,
  onClose,
  onRolledBack,
  onPreview,
}: {
  item: AdminCatalogItem;
  onClose: () => void;
  onRolledBack: (item: AdminCatalogItem) => void;
  onPreview: (target: PreviewTarget) => void;
}) {
  const [versions, setVersions] = useState<CatalogVersion[] | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(
    () =>
      catalogApi.versions(item.id).then(
        (result) => {
          setVersions(result.versions);
          setProblem('');
        },
        (error: unknown) => setProblem(problemText(error)),
      ),
    [item.id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const rollback = async (version: CatalogVersion) => {
    const question = `${item.label}을(를) 버전 #${version.id}(으)로 되돌릴까요? 공개 상태·이름·이모지·순서는 그대로예요.`;
    if (!window.confirm(question)) return;
    setBusy(version.id);
    try {
      onRolledBack(await catalogApi.rollback(item.id, version.id));
      await load();
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog title={`${item.label} · 버전 기록`} onClose={onClose} wide>
      {problem && (
        <p className="mg-error" role="alert">
          {problem}
        </p>
      )}
      {versions === null && !problem && <p className="mg-empty">버전 기록을 불러오는 중…</p>}
      {versions?.length === 0 && <p className="mg-empty">기록된 버전이 없어요. 기본 미니미는 버전을 두지 않아요.</p>}
      <ol className="mg-admin-versions">
        {versions?.map((version) => (
          <li key={version.id} className={version.current ? 'is-current' : undefined}>
            <div className="mg-admin-version-head">
              <Thumb src={version.thumbnailUrl} fallback={item.emoji} />
              <div className="mg-admin-version-main">
                <b>
                  버전 #{version.id} {version.current && <span className="mg-badge is-published">지금 보이는 버전</span>}
                </b>
                <small>
                  {formatWhen(version.createdAt)}
                  {version.createdBy ? ` · ${version.createdBy}` : ''}
                </small>
                <small>
                  <code>{version.sourceRef ?? '출처 기록 없음'}</code>
                  {version.stage ? ` · ${version.stage}` : ''}
                </small>
                <span className="mg-admin-chips">
                  <ReportBadges report={version.report} />
                </span>
              </div>
            </div>
            <div className="mg-admin-actions">
              <button
                type="button"
                className="mg-btn is-quiet is-small"
                onClick={() => onPreview({ title: `${item.label} #${version.id}`, url: version.modelUrl })}
              >
                3D 보기
              </button>
              {version.report && (
                <button type="button" className="mg-btn is-quiet is-small" aria-expanded={open === version.id} onClick={() => setOpen(open === version.id ? null : version.id)}>
                  {open === version.id ? '보고서 닫기' : '보고서'}
                </button>
              )}
              {!version.current && (
                <button type="button" className="mg-btn is-small" disabled={busy !== null} onClick={() => void rollback(version)}>
                  {busy === version.id ? '되돌리는 중…' : '이 버전으로 되돌리기'}
                </button>
              )}
            </div>
            {open === version.id && version.report && <ReportView report={version.report} />}
          </li>
        ))}
      </ol>
    </Dialog>
  );
}
