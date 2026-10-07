import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useFocusTrap } from '../../ui/focus';
import { ISLANDS, templateOf, type IslandId } from '../islands';
import { parseIsland } from '../islands/domain';
import type { KeptIsland } from './islandChange';
import { clock, type SaverState } from './save';

/**
 * When the island chooser is open: on an owner's visit to their island while nothing of it was ever saved (asked once,
 * as soon as it has loaded, so a sign-up lands on it), and when the decorating drawer opens it to change the island.
 * `stored` is the save adapter, whose revision is 0 while nothing is stored.
 */
export function useIslandChooser(isOwner: boolean, phase: SaverState['phase'], stored: { readonly revision: number }) {
  const [mode, setMode] = useState<'first' | 'change' | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (!isOwner || phase !== 'ready' || asked.current) return;
    asked.current = true;
    if (stored.revision === 0) setMode('first');
  }, [isOwner, phase, stored]);
  const change = useCallback(() => setMode('change'), []);
  const close = useCallback(() => setMode(null), []);
  return { mode, change, close };
}

/** The island kept from before, as the chooser shows it. */
type Previous = { kind: IslandId; updatedAt: string };

export type IslandChooserProps = {
  /** `first`: an owner's island that was never saved; `change`: from the decorating drawer. */
  mode: 'first' | 'change';
  current: IslandId;
  onChange: (id: IslandId) => Promise<unknown>;
  onRestore: () => Promise<unknown>;
  /** The kept island from before, read when the chooser opens to change. */
  loadPrevious: () => Promise<KeptIsland | null>;
  /** Closing the first chooser keeps the island it shows. */
  onKeep: () => Promise<unknown>;
  onClose: () => void;
};

/** `word` with 로 or 으로 after it, as its last syllable takes. */
function toward(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  const final = code >= 0 && code < 11172 ? code % 28 : 0;
  return `${word}${final === 0 || final === 8 ? '로' : '으로'}`;
}

const keptAt = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${date.getMonth() + 1}월 ${date.getDate()}일 ${clock(date.getTime())}`;
};

/**
 * 섬 고르기 and 섬 바꾸기: a card per kind of island. On a first visit a card is the island at once; changing asks first,
 * and the island from before the last change is one more card.
 */
export function IslandChooser({ mode, current, onChange, onRestore, loadPrevious, onKeep, onClose }: IslandChooserProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<IslandId | 'previous' | null>(null);
  const [previous, setPrevious] = useState<Previous | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useFocusTrap(dialog);
  useEffect(() => {
    if (mode !== 'change') return undefined;
    let alive = true;
    loadPrevious().then(
      (kept) => {
        if (alive && kept) setPrevious({ kind: parseIsland(kept.blob.domains?.['island']), updatedAt: kept.updatedAt });
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [mode, loadPrevious]);
  useEffect(() => {
    const node = dialog.current;
    if (busy && node && !node.contains(document.activeElement)) node.focus();
  }, [busy]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : '섬을 바꾸지 못했어요.');
      setBusy(false);
    }
  };
  const close = () => {
    if (busy) return;
    if (mode === 'first') void onKeep().catch(() => {});
    onClose();
  };
  const pick = (id: IslandId) => {
    if (mode === 'first') void run(() => onChange(id));
    else setPicked(id);
  };
  const pickedLabel = picked === 'previous' ? '이전 섬' : picked ? templateOf(picked).label : '';

  return createPortal(
    <div
      className="mg-island-backdrop"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <div ref={dialog} className="mg-island-dialog mg-glass" role="dialog" aria-modal="true" aria-labelledby="mg-island-title" aria-busy={busy} tabIndex={-1}>
        <header>
          <h2 id="mg-island-title">{mode === 'first' ? '섬 고르기' : '섬 바꾸기'}</h2>
          <button className="mg-btn is-small" disabled={busy} onClick={close}>
            닫기
          </button>
        </header>
        <div className="mg-island-cards">
          {ISLANDS.map((template) => (
            <button key={template.id} className="mg-island-card" aria-pressed={picked === template.id} disabled={busy} onClick={() => pick(template.id)}>
              <img src={template.picture} alt="" />
              <span>{template.label}</span>
              {mode === 'change' && template.id === current && <span className="mg-badge">지금</span>}
            </button>
          ))}
          {previous && (
            <button className="mg-island-card" aria-pressed={picked === 'previous'} disabled={busy} onClick={() => setPicked('previous')}>
              <img src={templateOf(previous.kind).picture} alt="" />
              <span>이전 섬</span>
              <small>{keptAt(previous.updatedAt)}</small>
            </button>
          )}
        </div>
        {picked && (
          <div className="mg-row mg-island-confirm">
            <span>{toward(pickedLabel)} 바꿀까요?</span>
            <button className="mg-btn is-primary is-small" disabled={busy} onClick={() => void run(picked === 'previous' ? onRestore : () => onChange(picked))}>
              바꾸기
            </button>
            <button className="mg-btn is-small" disabled={busy} onClick={() => setPicked(null)}>
              취소
            </button>
          </div>
        )}
        {error && (
          <p className="mg-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
