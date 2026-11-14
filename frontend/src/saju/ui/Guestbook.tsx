import { useState, type FormEvent } from 'react';

import { Link } from 'react-router-dom';

import type { Element } from '../elements';
import { ENTRY_MAX, type GuestEntry } from '../residents';
import { homePath, SAJU } from '../routes';
import { canErase, sajuStore } from '../store';
import { PixelIcon } from './PixelIcon';

const dated = (at: string) => {
  const date = new Date(at);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
};

/**
 * 방명록: the lines left at a home, newest first, and a line to leave. Writing takes a home of one's own to sign with;
 * without one the way to build it stands in the form's place.
 */
export function Guestbook({ home, entries, canWrite, elementOf }: {
  home: string;
  entries: readonly GuestEntry[];
  canWrite: boolean;
  /** The element a writer's home leans to, for the mark beside their name; null for someone no longer in the village. */
  elementOf: (author: string) => Element | null;
}) {
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    sajuStore.write(home, text);
    setText('');
  };
  return (
    <section className="mg-saju-guestbook" aria-label="방명록">
      <h2 className="mg-heading">
        방명록 <b>{entries.length}</b>
      </h2>
      {canWrite ? (
        <form className="mg-saju-write" onSubmit={submit}>
          <input
            className="mg-field"
            value={text}
            maxLength={ENTRY_MAX}
            placeholder="일촌평 남기기"
            aria-label="일촌평"
            enterKeyHint="send"
            onChange={(event) => setText(event.target.value)}
          />
          <button className="mg-btn is-primary" type="submit" disabled={!text.trim()}>
            남기기
          </button>
        </form>
      ) : (
        <Link className="mg-btn is-small" to={SAJU}>
          내 집 짓기
        </Link>
      )}
      {entries.length === 0 && <p className="mg-empty">방명록이 없어요</p>}
      <ul className="mg-saju-entries">
        {entries.map((entry) => {
          const element = elementOf(entry.author);
          return (
            <li key={entry.id}>
              <Link className="mg-saju-entry-mark" data-element={element ?? undefined} to={homePath(entry.author)} aria-label={`${entry.name}의 미니홈피`}>
                <PixelIcon name={element ?? 'house'} size={18} />
              </Link>
              <div>
                <p className="mg-saju-entry-meta">
                  <b>{entry.name}</b>
                  <time dateTime={entry.at}>{dated(entry.at)}</time>
                  {canErase(entry) && (
                    <button className="mg-link" aria-label={`${entry.name}의 글 삭제`} onClick={() => sajuStore.erase(entry.id)}>
                      삭제
                    </button>
                  )}
                </p>
                <p className="mg-saju-entry-body">{entry.body}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
