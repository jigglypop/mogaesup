import type { Element } from '../elements';

/** Nine-by-nine pixel drawings: the five elements (a tree, a flame, a hill, a gem, a drop) and the village's house. */
const BITMAPS = {
  wood: ['....#....', '...###...', '..#####..', '.#######.', '..#####..', '.#######.', '#########', '....#....', '....#....'],
  fire: ['....#....', '...##....', '...###...', '..####.#.', '.#####.##', '.#######.', '.#######.', '..#####..', '...###...'],
  earth: ['.........', '....#....', '...###...', '..#####..', '..#####..', '.#######.', '.#######.', '#########', '.........'],
  metal: ['.........', '..#####..', '.#######.', '#########', '.#######.', '..#####..', '...###...', '....#....', '.........'],
  water: ['....#....', '....#....', '...###...', '..#####..', '.#######.', '.#######.', '.#######.', '..#####..', '...###...'],
  house: ['....#....', '...###...', '..#####..', '.#######.', '#########', '.#######.', '.##.#.##.', '.##.#.##.', '.#######.'],
} as const;

export type PixelName = Element | 'house';

/** Each row's filled runs as one path, so a drawing is a single crisp shape. */
function pathOf(rows: readonly string[]): string {
  let path = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '#') continue;
      let end = x;
      while (row[end + 1] === '#') end++;
      path += `M${x} ${y}h${end - x + 1}v1h-${end - x + 1}z`;
      x = end;
    }
  });
  return path;
}

const PATHS = Object.fromEntries(Object.entries(BITMAPS).map(([name, rows]) => [name, pathOf(rows)])) as Record<PixelName, string>;

/** A pixel drawing in the text colour, `size` pixels square. */
export function PixelIcon({ name, size = 18 }: { name: PixelName; size?: number }) {
  return (
    <svg className="mg-saju-pixel" viewBox="0 0 9 9" width={size} height={size} shapeRendering="crispEdges" fill="currentColor" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
