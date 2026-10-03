import { useState } from 'react';

import type { CatalogImport } from '../../api/types';
import { Icon } from '../../ui/icons';
import { formatWhen, isActive, outcomeText } from './catalogView';
import { ImportProgress, ReportBadges } from './parts';
import { ReportView } from './ReportView';

/** Finished imports shown before "더 보기". */
const RECENT = 5;

const STATUS_BADGE: Record<CatalogImport['status'], { label: string; tone: string }> = {
  queued: { label: '대기', tone: 'is-draft' },
  running: { label: '진행 중', tone: 'is-paid' },
  done: { label: '완료', tone: 'is-published' },
  failed: { label: '실패', tone: 'is-error' },
};

function ImportRow({ item, onRetry }: { item: CatalogImport; onRetry: (item: CatalogImport) => void }) {
  const [open, setOpen] = useState(false);
  const badge = STATUS_BADGE[item.status];
  const active = isActive(item);
  return (
    <li className={`mg-admin-import is-${item.status}`}>
      <div className="mg-admin-import-head">
        <span className="mg-admin-import-emoji" aria-hidden="true">
          {item.emoji}
        </span>
        <div className="mg-admin-import-name">
          <b>{item.label}</b>
          <small>
            <code>{item.itemId}</code> · {item.replaces ? '업데이트' : '새 항목'} · {formatWhen(item.createdAt)}
            {item.requestedBy ? ` · ${item.requestedBy}` : ''}
          </small>
        </div>
        <span className={`mg-badge ${badge.tone}`}>{badge.label}</span>
      </div>
      {active ? (
        <ImportProgress item={item} />
      ) : (
        <div className="mg-admin-import-result">
          <p className={item.status === 'failed' ? 'mg-error' : undefined}>{outcomeText(item)}</p>
          <div className="mg-admin-actions">
            <ReportBadges report={item.report} />
            {item.report && (
              <button type="button" className="mg-btn is-quiet is-small" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? '보고서 닫기' : '보고서'}
              </button>
            )}
            {item.status === 'failed' && (
              <button type="button" className="mg-btn is-small" onClick={() => onRetry(item)}>
                <Icon name="rotate" /> 다시 시도
              </button>
            )}
          </div>
        </div>
      )}
      {open && item.report && <ReportView report={item.report} />}
    </li>
  );
}

/** The imports running in the background and the latest finished ones, each with its report. */
export function ImportPanel({
  imports,
  problem,
  onRetry,
}: {
  imports: CatalogImport[] | null;
  problem: string;
  onRetry: (item: CatalogImport) => void;
}) {
  const [all, setAll] = useState(false);
  const running = (imports ?? []).filter(isActive);
  const ended = (imports ?? []).filter((item) => !isActive(item));
  const shown = all ? ended : ended.slice(0, RECENT);
  return (
    <section className="mg-card mg-admin-imports" aria-label="가져오기 작업">
      <header>
        <b>가져오기 작업</b>
        <span>{running.length ? `진행 중 ${running.length}` : '진행 중인 작업 없음'}</span>
      </header>
      {problem && (
        <p className="mg-error" role="alert">
          {problem}
        </p>
      )}
      {imports === null && !problem && <p className="mg-empty">가져오기 기록을 불러오는 중…</p>}
      {imports !== null && imports.length === 0 && <p className="mg-empty">가져오기 기록이 없어요</p>}
      <ol className="mg-admin-import-list">
        {[...running, ...shown].map((item) => (
          <ImportRow key={item.id} item={item} onRetry={onRetry} />
        ))}
      </ol>
      {ended.length > RECENT && (
        <button type="button" className="mg-btn is-quiet is-small" onClick={() => setAll(!all)}>
          {all ? '최근 것만 보기' : `지난 기록 ${ended.length - RECENT}건 더 보기`}
        </button>
      )}
    </section>
  );
}
