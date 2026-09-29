import { Icon } from '../ui/icons';

export function Loading() {
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
