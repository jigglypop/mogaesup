import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function AssetDetailDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="admin-detail-dialog workspace" aria-labelledby="asset-detail-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="admin-detail-heading"><h2 id="asset-detail-title">{title}</h2><button type="button" autoFocus onClick={onClose}>닫기</button></div>
    <div className="workspace-content admin-detail-content">{children}</div>
  </dialog>, document.body);
}
