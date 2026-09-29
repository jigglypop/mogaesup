import type { PlacedObject } from 'gaesup-world/building';

import { Icon } from '../../ui/icons';
import { EditIcon } from './icons';
import { degreesOf, objectLabel, SIZE_RANGE, sizeOf, turnable } from './objects';
import type { EditSession } from './session';

export const EIGHTHS = [0, 45, 90, 135, 180, 225, 270, 315];

export function Turns({ values, current, onTurn }: { values: number[]; current: number; onTurn: (degrees: number) => void }) {
  return (
    <div className={`mg-tabs mg-turns${values.length > 4 ? ' is-eighths' : ''}`} role="radiogroup" aria-label="회전">
      {values.map((value) => (
        <button key={value} role="radio" aria-checked={current === value} onClick={() => onTurn(value)}>
          {value}°
        </button>
      ))}
    </div>
  );
}

export function Stepper({ label, value, onLess, onMore, lessDisabled, moreDisabled }: {
  label: string;
  value: string;
  onLess: () => void;
  onMore: () => void;
  lessDisabled?: boolean;
  moreDisabled?: boolean;
}) {
  return (
    <div className="mg-stepper" role="group" aria-label={label}>
      <button className="mg-icon-btn is-quiet" aria-label={`${label} 줄이기`} disabled={lessDisabled} onClick={onLess}>
        <EditIcon name="minus" />
      </button>
      <output aria-live="polite">{value}</output>
      <button className="mg-icon-btn is-quiet" aria-label={`${label} 늘리기`} disabled={moreDisabled} onClick={onMore}>
        <EditIcon name="plus" />
      </button>
    </div>
  );
}

/** The inspector for the object the 선택 tool picked: turn, size, copy, delete. */
export function SelectionInspector({ session, object }: { session: EditSession; object: PlacedObject }) {
  const degrees = degreesOf(object.rotation);
  const size = sizeOf(object);
  return (
    <>
      <header>
        <b>{objectLabel(object, session.labels)}</b>
        <small>{turnable(object) ? '끌어서 옮겨요 · 화살표 1m · R 90° · Shift+R 45°' : '끌어서 옮겨요 · 화살표 1m'}</small>
      </header>
      {turnable(object) && (
        <div className="mg-label">
          회전 {EIGHTHS.includes(degrees) ? '' : `${degrees}°`}
          <Turns values={EIGHTHS} current={degrees} onTurn={(value) => session.setSelectedRotation(value)} />
        </div>
      )}
      {size !== null && (
        <div className="mg-label">
          크기
          <Stepper
            label="크기"
            value={`${Math.round(size * 100)}%`}
            lessDisabled={size <= SIZE_RANGE.min + 1e-6}
            moreDisabled={size >= SIZE_RANGE.max - 1e-6}
            onLess={() => session.resizeSelected(size - SIZE_RANGE.step)}
            onMore={() => session.resizeSelected(size + SIZE_RANGE.step)}
          />
        </div>
      )}
      <div className="mg-selection-actions">
        <button className="mg-btn is-small" title="Ctrl+D" onClick={() => session.duplicateSelected()}>
          <EditIcon name="copy" /> 복제
        </button>
        <button className="mg-btn is-small" title="F" onClick={() => session.focusSelected()}>
          <EditIcon name="focus" /> 보기
        </button>
        <button className="mg-btn is-danger is-small" title="Delete" onClick={() => session.deleteSelected()}>
          <Icon name="trash" /> 지우기
        </button>
      </div>
    </>
  );
}
