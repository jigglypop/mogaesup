import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode; onReload?: () => void };

/** Catches what throws while the app draws, so a page does not go blank: one way out, which starts over. */
export class AppErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error) {
    console.error('[app]', error);
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="mg-loading">
        <section className="mg-glass mg-panel mg-notice" role="alert">
          <h1 className="mg-title">문제가 생겼어요</h1>
          <button className="mg-btn is-primary" onClick={this.props.onReload ?? (() => location.reload())}>
            다시 불러오기
          </button>
        </section>
      </div>
    );
  }
}
