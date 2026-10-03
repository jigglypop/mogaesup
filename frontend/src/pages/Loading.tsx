import { useOptionalAuth } from '../auth/AuthProvider';
import { Icon } from '../ui/icons';

/** The wait before a screen; while it waits on a server that keeps not answering who is signed in, it says so. */
export function Loading() {
  const auth = useOptionalAuth();
  if (auth?.status === 'loading' && auth.unreachable) {
    return (
      <div className="mg-loading">
        <div className="mg-loading-card mg-glass" role="alert">
          <span className="mg-brand-mark is-still" aria-hidden="true">
            <Icon name="island" />
          </span>
          <b>서버에 연결하지 못했어요</b>
          <button className="mg-btn is-primary is-small" onClick={auth.retry}>
            다시 시도
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="mg-loading" role="status">
      <div className="mg-loading-card mg-glass">
        <span className="mg-brand-mark" aria-hidden="true">
          <Icon name="island" />
        </span>
        <b>불러오는 중</b>
        <span className="mg-progress is-indeterminate">
          <i />
        </span>
      </div>
    </div>
  );
}
