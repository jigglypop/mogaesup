import { useEffect, useRef } from 'react';

import type { HomeView } from '../../api/types';
import { Brand, usePopover } from '../../shell/Shell';
import { Icon } from '../../ui/icons';
import { useEditState, useHistory, useSaver } from './context';
import { EditIcon } from './icons';
import { clock, describeStatus, SIZE_LIMIT_TEXT, sizeText, type IslandSaver } from './save';
import type { EditSession } from './session';
import { useEditKeys } from './useEditKeys';
import { MAX_ISLAND_BYTES } from '../persistence';

type EditBarProps = { view: HomeView; session: EditSession; saver: IslandSaver; onSave: () => void; onExit: () => void };

/** The decorating top bar: save state, undo and redo, leaving and saving; it also owns the decorating shortcuts. */
export function EditBar({ view, session, saver, onSave, onExit }: EditBarProps) {
  const history = useHistory(session.history);
  const saving = useSaver(saver).saving;
  useEditKeys(session, { save: onSave });
  return (
    <header className="mg-topbar">
      <div className="mg-topbar-left">
        <Brand />
        <span className="mg-pill mg-glass mg-edit-title">
          <span>{view.profile.title}</span>
          <span className="mg-badge is-draft">꾸미는 중</span>
        </span>
      </div>
      <div className="mg-topbar-right">
        <SaveStatus saver={saver} />
        <span className="mg-pill mg-glass mg-undo">
          <button className="mg-icon-btn is-quiet" aria-label="되돌리기" title="되돌리기 (Ctrl+Z)" disabled={!history.canUndo} onClick={history.undo}>
            <Icon name="undo" />
          </button>
          <button className="mg-icon-btn is-quiet" aria-label="다시 하기" title="다시 하기 (Ctrl+Shift+Z)" disabled={!history.canRedo} onClick={history.redo}>
            <Icon name="redo" />
          </button>
        </span>
        <button className="mg-btn" onClick={onExit}>
          나가기
        </button>
        <button className="mg-btn is-primary" title="저장 (Ctrl+S)" disabled={saving} onClick={onSave}>
          저장
        </button>
      </div>
    </header>
  );
}

/** Shortcut help for the session, opened by ? or the toolbar. */
export function EditHelp({ session }: { session: EditSession }) {
  const open = useEditState(session, (state) => state.help);
  return open ? <ShortcutHelp onClose={() => session.setHelp(false)} /> : null;
}

/** The save state beside the undo buttons: a dot and a word, with the details and a retry behind a click. */
function SaveStatus({ saver }: { saver: IslandSaver }) {
  const state = useSaver(saver);
  const status = describeStatus(state);
  const { open, setOpen, ref } = usePopover();
  const retry = state.phase === 'ready' && !state.conflict && !state.saving && state.problem !== null;
  return (
    <div className="mg-anchor" ref={ref}>
      <button
        className="mg-pill mg-glass mg-save-status"
        data-tone={status.tone}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`저장 상태: ${status.label}`}
        onClick={() => setOpen(!open)}
      >
        <i className="mg-save-dot" aria-hidden="true" />
        <span>{status.label}</span>
        {status.tone === 'good' && state.lastSavedAt && <small>{clock(state.lastSavedAt)}</small>}
      </button>
      {open && (
        <div className="mg-popover mg-menu mg-save-pop is-right" role="dialog" aria-label="저장 상태">
          <p className="mg-menu-title">{status.label}</p>
          <p className="mg-save-detail">{status.detail}</p>
          {state.bytes !== null && (
            <div className="mg-save-size">
              <span>
                섬 크기 <b>{sizeText(state.bytes)}</b> / {SIZE_LIMIT_TEXT}
              </span>
              <meter min={0} max={MAX_ISLAND_BYTES} low={MAX_ISLAND_BYTES * 0.75} high={MAX_ISLAND_BYTES * 0.9} optimum={0} value={state.bytes} />
            </div>
          )}
          {retry && (
            <button className="mg-btn is-primary is-small mg-save-retry" onClick={() => void saver.save()}>
              다시 시도
            </button>
          )}
        </div>
      )}
      <span className="mg-sr" role="status">
        {status.tone === 'busy' ? '' : status.label}
      </span>
    </div>
  );
}

/**
 * What needs the owner's say about saving: another copy of the island saved first, the island did not load, or saving
 * keeps failing. Edits stay in the world meanwhile; nothing here reloads the page.
 */
export function SaveBanners({ saver, editing, onReloaded }: { saver: IslandSaver; editing: boolean; onReloaded: () => void }) {
  const state = useSaver(saver);
  if (state.phase === 'loadFailed') {
    return (
      <div className="mg-conflict mg-glass" role="alert">
        <span>{state.problem?.message ?? '섬을 불러오지 못했어요.'}</span>
        <button className="mg-btn is-primary is-small" onClick={() => void saver.load().then((ok) => ok && onReloaded())}>
          다시 불러오기
        </button>
      </div>
    );
  }
  if (state.conflict) {
    return (
      <div className="mg-conflict mg-glass mg-save-conflict" role="alert">
        <span>
          다른 곳에서 이 섬을 먼저 저장했어요. 여기서 꾸민 모습은 아직 그대로 있어요.
          <small>자동 저장은 고를 때까지 멈춰 있어요.</small>
        </span>
        <div className="mg-row">
          <button className="mg-btn is-primary is-small" disabled={state.saving} onClick={() => void saver.overwrite()}>
            내 편집으로 덮어쓰기
          </button>
          <button
            className="mg-btn is-small"
            disabled={state.saving}
            onClick={() => {
              if (window.confirm('여기서 꾸민 내용은 사라지고, 먼저 저장된 섬을 불러와요. 계속할까요?')) {
                void saver.reloadLatest().then((ok) => ok && onReloaded());
              }
            }}
          >
            최신 섬 불러오기
          </button>
        </div>
      </div>
    );
  }
  if (editing && state.problem && state.phase === 'ready' && !state.saving) {
    return (
      <div className="mg-conflict mg-glass mg-save-problem" role="alert">
        <EditIcon name="alert" />
        <span>{state.problem.message}</span>
        <button className="mg-btn is-small" onClick={() => void saver.save()}>
          다시 시도
        </button>
      </div>
    );
  }
  return null;
}

const TOUCH = {
  title: '손가락으로',
  keys: [
    [['톡'], '물건 고르기 · 놓기'],
    [['물건 끌기'], '고른 물건 옮기기'],
    [['빈 곳 끌기'], '화면 옮기기'],
    [['두 손가락 벌리기'], '가까이·멀리'],
    [['두 손가락 끌기'], '돌려 보기'],
  ] as [string[], string][],
};

const SHORTCUTS: { title: string; keys: [keys: string[], label: string][] }[] = [
  {
    title: '고르고 옮기기 (선택 도구)',
    keys: [
      [['클릭'], '물건 고르기'],
      [['끌기'], '고른 물건 옮기기'],
      [['←', '↑', '→', '↓'], '1m씩 옮기기'],
      [['R'], '90° 돌리기'],
      [['Shift', 'R'], '45° 돌리기'],
      [['Ctrl', 'D'], '옆에 복제'],
      [['Delete'], '지우기'],
      [['F'], '고른 물건으로 화면 옮기기'],
      [['Esc'], '선택 풀기'],
    ],
  },
  {
    title: '도구',
    keys: [
      [['1'], '선택'],
      [['2'], '놓기'],
      [['3'], '칠하기'],
      [['4'], '지우기'],
      [['R'], '놓을 조각 돌리기 (놓기 도구)'],
      [['Q', 'E'], '바닥 높이 내리기·올리기'],
      [['Esc'], '선택 도구로 돌아가기'],
    ],
  },
  {
    title: '화면',
    keys: [
      [['빈 곳 끌기'], '화면 옮기기'],
      [['Shift', '끌기'], '물건 위에서도 화면 옮기기'],
      [['W', 'A', 'S', 'D'], '화면 옮기기 (Shift로 빠르게)'],
      [['←', '↑', '→', '↓'], '고른 물건이 없을 때 화면 옮기기'],
      [['오른쪽 끌기'], '돌려 보기'],
      [['휠'], '가까이·멀리'],
      [['T'], '위에서 보기'],
    ],
  },
  {
    title: '편집',
    keys: [
      [['Ctrl', 'Z'], '되돌리기'],
      [['Ctrl', 'Shift', 'Z'], '다시 하기'],
      [['Ctrl', 'S'], '지금 저장'],
      [['?'], '단축키 보기'],
    ],
  },
];

/** Every decorating shortcut and gesture, from the ? key or the toolbar; touch comes first on a touch screen. */
function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  const groups = matchMedia('(pointer: coarse)').matches ? [TOUCH, ...SHORTCUTS] : [...SHORTCUTS, TOUCH];
  return (
    <div className="mg-help-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="mg-help mg-glass" role="dialog" aria-modal="true" aria-label="꾸미기 단축키">
        <header>
          <h2 className="mg-heading">꾸미기 단축키와 손동작</h2>
          <button ref={close} className="mg-icon-btn is-quiet" aria-label="닫기" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="mg-help-groups">
          {groups.map((group) => (
            <div key={group.title} className="mg-help-group">
              <h3>{group.title}</h3>
              <dl>
                {group.keys.map(([keys, label]) => (
                  <div key={`${keys.join('+')}-${label}`}>
                    <dt>
                      {keys.map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </dt>
                    <dd>{label}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
