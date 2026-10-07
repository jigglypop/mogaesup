/** A balloon on screen: `x` is its tail's tip across, `y` the tip's height (its bottom), in CSS pixels. */
export type BalloonBox = { id: string; x: number; y: number; width: number; height: number; distance: number };

/** Space kept between two balloons stacked one over the other. */
const GAP = 4;
/** Lifts a balloon gets at most: one past another, again past the next, … */
const ROUNDS = 6;

const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
type Rect = { left: number; right: number; top: number; bottom: number };
const rect = (box: BalloonBox, lift: number): Rect => ({
  left: box.x - box.width / 2,
  right: box.x + box.width / 2,
  top: box.y - lift - box.height,
  bottom: box.y - lift,
});

/**
 * How far up (px, ≥ 0) each balloon goes so none covers another: the nearest stay where they are, and one that would
 * cover a nearer one goes up above it, again past the next it then meets, up to {@link ROUNDS} times.
 */
export function stackBalloons(boxes: readonly BalloonBox[]): Map<string, number> {
  const lifts = new Map<string, number>();
  const placed: Rect[] = [];
  for (const box of [...boxes].sort((a, b) => a.distance - b.distance)) {
    let lift = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const at = rect(box, lift);
      const below = placed.find((other) => overlaps(at, other));
      if (!below) break;
      lift = box.y - (below.top - GAP);
    }
    placed.push(rect(box, lift));
    lifts.set(box.id, lift);
  }
  return lifts;
}
