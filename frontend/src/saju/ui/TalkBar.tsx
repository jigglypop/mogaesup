import { useEffect, useRef, useState } from 'react';

import type { Action, Line } from '../live';
import { Icon } from '../../ui/icons';

/** The moves the viewer's dog can make, as the bar offers them. */
const MOVES: readonly { action: Action; label: string; mark: string }[] = [
  { action: 'jump', label: '점프', mark: '⤴' },
  { action: 'wave', label: '손 흔들기', mark: '👋' },
  { action: 'cheer', label: '만세', mark: '🙌' },
  { action: 'dance', label: '춤추기', mark: '💃' },
];

const timeOf = (at: number) => new Date(at).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });

/**
 * The room's talk under the picture: the lines so far (what was said, who came and went), the box to say something in,
 * and the moves the viewer's dog can make. Enter anywhere on the page (outside a box) goes to the talk; Esc leaves it.
 */
export function TalkBar({ log, others, onSay, onMove }: { log: readonly Line[]; others: number; onSay: (text: string) => boolean; onMove: (action: Action) => void }) {
  const [line, setLine] = useState('');
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const said = log.filter((entry) => entry.kind === 'said');
  const unread = open ? 0 : said.filter((entry) => !entry.own && entry.key > seen).length;
  useEffect(() => {
    if (open && log.length) setSeen(log[log.length - 1]!.key);
  }, [open, log]);
  useEffect(() => {
    const box = list.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [log, open]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      const target = event.target as Element | null;
      if (target?.closest('input, textarea, select, button, a, [contenteditable]')) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return (
    <div className="mg-saju-talk-box" data-open={open || undefined}>
      {open && (
        <ol className="mg-saju-talk-log mg-glass" ref={list} aria-label="대화" aria-live="polite">
          {log.length === 0 && <li className="is-note">{others > 0 ? `${others}명이 함께 있어요` : '아직 아무도 없어요'}</li>}
          {log.map((entry) =>
            entry.kind === 'said' ? (
              <li key={entry.key} data-own={entry.own || undefined}>
                <b>{entry.own ? '나' : entry.name}</b>
                <span>{entry.text}</span>
                <time>{timeOf(entry.at)}</time>
              </li>
            ) : (
              <li key={entry.key} className="is-note">
                {entry.name}님이 {entry.kind === 'came' ? '들어왔어요' : '나갔어요'}
              </li>
            ),
          )}
        </ol>
      )}
      <form
        className="mg-saju-talk mg-glass"
        onSubmit={(event) => {
          event.preventDefault();
          if (onSay(line)) setLine('');
        }}
      >
        <button type="button" className="mg-icon-btn is-quiet mg-saju-talk-toggle" aria-label={open ? '대화 접기' : '대화 펼치기'} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="users" />
          {unread > 0 && <i className="mg-saju-talk-unread">{unread > 9 ? '9+' : unread}</i>}
        </button>
        <input
          ref={input}
          value={line}
          maxLength={200}
          onChange={(event) => setLine(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.currentTarget.blur();
          }}
          aria-label="말하기"
          placeholder="말하기"
          enterKeyHint="send"
        />
        <span className="mg-saju-moves" role="group" aria-label="동작">
          {MOVES.map((move) => (
            <button key={move.action} type="button" className="mg-icon-btn is-quiet" aria-label={move.label} title={move.label} onClick={() => onMove(move.action)}>
              <span aria-hidden="true">{move.mark}</span>
            </button>
          ))}
        </span>
      </form>
    </div>
  );
}
