/**
 * 모개숲's mark: a small wooded island, a round tree and a pine on its rise above a line of water. Drawn in the colour it
 * is set in (`currentColor`), on whatever tile holds it.
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M15.6 3.2 20.2 12.4h-2.6l2 3.6h-8l2-3.6h-2.6z" fill="currentColor" opacity="0.72" />
      <circle cx="8.6" cy="9.4" r="4.6" fill="currentColor" />
      <path d="M8 13.4h1.3v3.6H8zM15 15.6h1.2v1.6H15z" fill="currentColor" />
      <path d="M3.4 17.6c2.3-1.4 4.9-2 8.6-2s6.3.6 8.6 2z" fill="currentColor" />
      <path d="M3 20.6c1.2-.9 2.4-.9 3.6 0s2.4.9 3.6 0 2.4-.9 3.6 0 2.4.9 3.6 0 2.4-.9 3.6 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.8" />
    </svg>
  );
}
