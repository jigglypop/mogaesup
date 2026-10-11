import { useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';

import { problemText } from '../api/client';
import { authApi } from '../api/endpoints';
import { useFocusTrap } from '../ui/focus';

/** The same bounds as signing up (and the server's), counted in characters. */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** What the current password is asked for: a new one, or signing out every other device of the account. */
export type PasswordAction = 'change' | 'others';

const TITLES: Record<PasswordAction, string> = { change: '비밀번호 바꾸기', others: '다른 기기에서 모두 로그아웃' };

/**
 * Changing the password (the current one and the new one), or signing out other devices (the current one), sent once;
 * what the server says went wrong stays on the form. A modal dialog over the page, closed by Escape, 취소 or 닫기, after
 * which the keyboard goes back where it was.
 */
export function PasswordDialog({ action = 'change', onClose }: { action?: PasswordAction; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  useFocusTrap(dialog, first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** What was done, once it is. */
  const [done, setDone] = useState('');
  const sending = useRef(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending.current) return;
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get('currentPassword') ?? '');
    const newPassword = String(form.get('newPassword') ?? '');
    const length = [...newPassword].length;
    if (!currentPassword) {
      setError('현재 비밀번호를 입력해 주세요.');
      return;
    }
    if (action === 'change' && (length < PASSWORD_MIN || length > PASSWORD_MAX)) {
      setError(`새 비밀번호는 ${PASSWORD_MIN}자 이상 ${PASSWORD_MAX}자 이하예요.`);
      return;
    }
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      if (action === 'change') {
        await authApi.changePassword({ currentPassword, newPassword });
        setDone('비밀번호를 바꿨어요');
      } else {
        const { ended } = await authApi.logoutOthers({ currentPassword });
        setDone(`다른 기기 ${ended}곳에서 로그아웃했어요`);
      }
    } catch (problem) {
      setError(problemText(problem));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="mg-modal-backdrop"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div ref={dialog} className="mg-modal mg-glass" role="dialog" aria-modal="true" aria-labelledby="mg-password-title" aria-busy={busy} tabIndex={-1}>
        <h2 id="mg-password-title" className="mg-heading">
          {TITLES[action]}
        </h2>
        {done ? (
          <>
            <p role="status">{done}</p>
            <div className="mg-row-end">
              <button className="mg-btn is-primary" onClick={onClose} autoFocus>
                닫기
              </button>
            </div>
          </>
        ) : (
          <form className="mg-modal-form" onSubmit={(event) => void submit(event)} noValidate>
            <label className="mg-label">
              현재 비밀번호
              <input ref={first} className="mg-field" name="currentPassword" type="password" required readOnly={busy} autoComplete="current-password" />
            </label>
            {action === 'change' && (
              <label className="mg-label">
                새 비밀번호
                <input
                  className="mg-field"
                  name="newPassword"
                  type="password"
                  required
                  minLength={PASSWORD_MIN}
                  maxLength={PASSWORD_MAX}
                  readOnly={busy}
                  autoComplete="new-password"
                />
              </label>
            )}
            {error && (
              <p className="mg-error" role="alert">
                {error}
              </p>
            )}
            <div className="mg-row-end">
              <button className="mg-btn" type="button" onClick={onClose}>
                취소
              </button>
              <button className="mg-btn is-primary" type="submit" aria-disabled={busy || undefined}>
                {action === 'change' ? (busy ? '바꾸는 중…' : '바꾸기') : busy ? '로그아웃하는 중…' : '로그아웃'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
