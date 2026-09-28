export function Loading() {
  return (
    <div className="gw-loading" role="status">
      <div className="gw-loading-card">
        <span className="gw-loading-island" aria-hidden>
          🏝️
        </span>
        <b>작은 세상을 여는 중</b>
        <span className="gw-loading-bar" />
      </div>
    </div>
  );
}
