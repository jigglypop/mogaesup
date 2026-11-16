// How the reading's text flows over as many pages as it needs. The blocks (a chapter's title, a heading, a paragraph)
// come in reading order with their lines already broken; this only says which lines go on which page and where.

/** A block of text as the flow sees it. */
export type Block = {
  /** How many lines it was broken into. */
  lines: number;
  lineHeight: number;
  /** Room above it, left out at the top of a page. */
  before: number;
  /** It begins a page of its own: a chapter's title. */
  breakBefore?: boolean;
  /** It stays on a page with the first lines of the block after it: a heading. */
  keepWithNext?: boolean;
};

/** Lines `from` up to `to` of a block, on one page, the first of them `y` below the top of the page's text. */
export type Placed = { block: number; from: number; to: number; y: number };

/** How few lines of a paragraph may stand alone at the foot of a page, or at the head of the next. */
export const KEEP = 2;

/** The fewest lines a block can begin with at a page's foot: a block too short to be split goes over whole. */
const headOf = (block: Block) => (block.lines < KEEP * 2 ? block.lines : KEEP);

/**
 * The pages `blocks` fill, each `height` tall: a list for each page of what lies on it, top first. A paragraph is
 * split between pages with at least {@link KEEP} lines on either side, and a heading is never the last thing on a page.
 * A page always takes a line, even one taller than the page.
 */
export function paginate(blocks: readonly Block[], height: number): Placed[][] {
  const pages: Placed[][] = [[]];
  let y = 0;
  const page = () => pages[pages.length - 1]!;
  const turn = () => {
    pages.push([]);
    y = 0;
  };
  blocks.forEach((block, index) => {
    if (block.lines <= 0) return;
    if (block.breakBefore && page().length > 0) turn();
    if (block.keepWithNext && y > 0) {
      const next = blocks.slice(index + 1).find((later) => later.lines > 0);
      const follow = next ? next.before + headOf(next) * next.lineHeight : 0;
      if (y + block.before + block.lines * block.lineHeight + follow > height) turn();
    }
    let from = 0;
    while (from < block.lines) {
      const top = from === 0 && y > 0 ? y + block.before : y;
      const room = Math.max(0, Math.floor((height - top) / block.lineHeight + 1e-9));
      const left = block.lines - from;
      let take = Math.min(room, left);
      if (take < left) {
        take = Math.min(take, left - KEEP);
        if (from === 0 && take < KEEP) take = 0;
      }
      if (take <= 0) {
        if (y > 0) {
          turn();
          continue;
        }
        take = Math.max(1, Math.min(room, left));
      }
      page().push({ block: index, from, to: from + take, y: top });
      y = top + take * block.lineHeight;
      from += take;
      if (from < block.lines) turn();
    }
  });
  return pages.filter((placed) => placed.length > 0);
}
