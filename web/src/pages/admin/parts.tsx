import { useState } from 'react';

import type { CatalogImport, ImportReport } from '../../api/types';
import { reportCounts, stepLabel, stepStates } from './catalogView';

/** A picture, or the emoji when there is none or it does not load (the character server's renders can be missing). */
export function Thumb({ src, fallback }: { src: string | null; fallback: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const shown = src && src !== broken ? src : null;
  return (
    <span className="mg-admin-thumb">
      {shown ? <img src={shown} alt="" loading="lazy" onError={() => setBroken(shown)} /> : <span aria-hidden="true">{fallback}</span>}
    </span>
  );
}

/** A picture that opens the 3D preview. */
export function ThumbButton({ src, fallback, label, onClick }: { src: string | null; fallback: string; label: string; onClick: () => void }) {
  return (
    <button type="button" className="mg-admin-thumb-button" aria-label={`${label} 3D로 보기`} title="3D로 보기" onClick={onClick}>
      <Thumb src={src} fallback={fallback} />
    </button>
  );
}

/** A running import's bar and step; the full view also lists every step. */
export function ImportProgress({ item, compact = false }: { item: CatalogImport; compact?: boolean }) {
  const waiting = item.status === 'queued';
  return (
    <div className="mg-admin-progress">
      <div
        className="mg-admin-bar"
        role="progressbar"
        aria-label={`${item.label} 가져오기`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={item.progress}
      >
        <i style={{ width: `${Math.max(4, item.progress)}%` }} />
      </div>
      <small>
        {waiting ? '차례를 기다리는 중' : `${stepLabel(item.step)} 중`}
        {item.detail ? ` · ${item.detail}` : ''} · {item.progress}%
      </small>
      {!compact && (
        <ol className="mg-admin-steps" aria-label="단계">
          {stepStates(item).map((entry) => (
            <li key={entry.step} className={`is-${entry.state}`}>
              {entry.label}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** `문제 1 · 주의 2` badges for a report, or `검사 통과`. */
export function ReportBadges({ report }: { report: ImportReport | null | undefined }) {
  if (!report) return null;
  const { errors, warnings } = reportCounts(report);
  if (!errors && !warnings) return <span className="mg-badge is-published">검사 통과</span>;
  return (
    <>
      {errors > 0 && <span className="mg-badge is-error">문제 {errors}</span>}
      {warnings > 0 && <span className="mg-badge is-draft">주의 {warnings}</span>}
    </>
  );
}
