import { useEffect, useId, useRef, type ReactNode } from 'react';

import { Icon } from '../../ui/icons';

/** A modal over the admin page. Escape, the close button and a tap outside the panel close it. */
export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    return () => dialog?.close?.();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`mg-admin-dialog${wide ? ' is-wide' : ''}`}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="mg-admin-dialog-panel">
        <header className="mg-admin-dialog-head">
          <h2 id={heading} className="mg-heading">
            {title}
          </h2>
          <button type="button" className="mg-icon-btn is-quiet" aria-label="닫기" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
