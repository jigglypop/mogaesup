import type { Builder, V3 } from './build';

// The island's 기념 방명록: a wooden frame by one of its paths, under a little roof of 기와, whose rails every line left
// in the guestbook hangs from as a wooden plaque on a red cord (as wishes hang at a temple). The frame is built with
// the island; the plaques come and go with the guestbook (see GuestPlaques). Drawn about its foot, facing +z.

/** The rails' heights and how far each reaches to either side of the middle. */
const RAILS = [1.36, 1.0, 0.64] as const;
const REACH = 0.82;
/** Plaques along each rail. */
export const PER_RAIL = 9;
/** As many plaques as the frame holds. */
export const PLAQUES = RAILS.length * PER_RAIL;
/** A plaque's size, and how far below its rail it hangs. */
export const PLAQUE: V3 = [0.12, 0.17, 0.018];
export const CORD = 0.1;

/** Where the `index`th plaque's cord meets its rail, about the frame's foot: the rails fill from the top, left to right. */
export function plaqueSpot(index: number): V3 {
  const rail = Math.floor(index / PER_RAIL) % RAILS.length;
  const along = index % PER_RAIL;
  return [-REACH + ((along + 0.5) / PER_RAIL) * REACH * 2, RAILS[rail]!, 0.035];
}

/** The frame: two posts on stones, a roof of 기와 over them, its rails and a board along the top. */
export function guestBoard(b: Builder, at: V3, turn = 0): void {
  const timber = '#6b4a32';
  const wood = { surface: 'wood' as const, rough: 0.8 };
  b.group(
    at,
    () => {
      for (const side of [-1, 1]) {
        b.cyl(0.13, 0.08, [side * 0.98, 0.04, 0], '#b5ad9d', { surface: 'stone', rough: 0.9, top: 0.1, sides: 10 });
        b.box([0.1, 1.84, 0.1], [side * 0.98, 0.92 + 0.04, 0], timber, wood);
      }
      // The rails, and the board across the top.
      for (const y of RAILS) b.cyl(0.02, REACH * 2 + 0.2, [0, y + 0.02, 0.035], timber, { ...wood, sides: 8 }, [0, 0, Math.PI / 2]);
      b.box([1.7, 0.2, 0.05], [0, 1.66, 0.03], '#8a6544', { ...wood, vary: 0.04 });
      b.box([1.76, 0.03, 0.07], [0, 1.775, 0.03], timber, wood);
      b.box([1.76, 0.03, 0.07], [0, 1.545, 0.03], timber, wood);
      // A little roof of 기와 over it all, its ridge along the frame.
      b.prism([2.3, 0.32, 0.62], [0, 1.88, 0], '#5d6168', { surface: 'clay', rough: 0.6, ridge: 1 });
      b.box([2.36, 0.06, 0.1], [0, 2.22, 0], '#43474e', { surface: 'clay', rough: 0.6 });
      for (const end of [-1, 1]) b.box([0.08, 0.16, 0.1], [end * 1.18, 2.26, 0], '#43474e', { surface: 'clay', rough: 0.6 }, [0, 0, end * -0.35]);
    },
    turn,
  );
}
