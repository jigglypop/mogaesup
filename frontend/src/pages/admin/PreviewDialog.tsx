import { Component, lazy, Suspense, type ReactNode } from 'react';

import { Dialog } from './Dialog';

const ModelPreview = lazy(() => import('./ModelPreview'));

export type PreviewTarget = { title: string; url: string; note?: string };

/** Keeps a renderer that cannot start from taking the admin page down with it. */
class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p className="mg-error" role="alert">
        이 기기에서는 3D 미리보기를 띄울 수 없어요.
      </p>
    ) : (
      this.props.children
    );
  }
}

export function PreviewDialog({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
  return (
    <Dialog title={`${target.title} · 3D`} onClose={onClose} wide>
      {target.note && <p className="mg-admin-fineprint">{target.note}</p>}
      <PreviewBoundary key={target.url}>
        <Suspense fallback={<p className="mg-empty">미리보기를 준비하는 중…</p>}>
          <ModelPreview url={target.url} />
        </Suspense>
      </PreviewBoundary>
    </Dialog>
  );
}
