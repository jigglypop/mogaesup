import { useEffect, useState } from 'react';

import { useWorldLoadProgress, type WorldLoadStage } from 'gaesup-world';

import { Icon } from '../ui/icons';

const STAGE: Record<WorldLoadStage, string> = { assets: '섬을 불러오는 중', shaders: '빛과 그림자를 준비하는 중', ready: '다 됐어요' };

/** Covers the stage until the island's first complete frame, so it does not appear piece by piece. */
export function WorldLoading() {
  const { stage, progress, loaded, total } = useWorldLoadProgress();
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (stage !== 'ready') return undefined;
    const timer = setTimeout(() => setGone(true), 600);
    return () => clearTimeout(timer);
  }, [stage]);
  if (gone) return null;
  const detail = stage === 'assets' && total > 0 ? `모델과 텍스처 ${loaded}/${total}` : ' ';
  return (
    <div className={`mg-world-loading${stage === 'ready' ? ' is-done' : ''}`} role="status" aria-live="polite">
      <div className="mg-loading-card mg-glass">
        <span className="mg-brand-mark" aria-hidden="true">
          <Icon name="island" />
        </span>
        <b>{STAGE[stage]}</b>
        {/* The count changes with every file; only the stage above is read out. */}
        <small aria-hidden="true">{detail}</small>
        <span className="mg-progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span>
      </div>
    </div>
  );
}
