import type { ReadingSection, SajuReading } from '../../api/types';
import { paginate, type Block, type Placed } from './flow';
import { paragraphsOf, wrap, type Measure } from './wrap';

// The reading as the PDF prints it: the 사주's chapter, then the 자미두수's, each a title, its summary, and its sections
// (a heading and paragraphs), set in lines and laid over as many pages as they fill.

/** What a passage of the reading is, which says how it is set. */
export type Kind = 'chapter' | 'summary' | 'heading' | 'paragraph';

/**
 * How each kind is set, in points: the type's size and weight, the height of a line, the room above it (see
 * {@link roomAbove}), and how far the lines stand in from the text's left edge.
 */
export const TYPE: Record<Kind, { size: number; weight: number; lineHeight: number; before: number; indent: number }> = {
  chapter: { size: 21, weight: 850, lineHeight: 30, before: 0, indent: 0 },
  summary: { size: 12, weight: 650, lineHeight: 21, before: 16, indent: 14 },
  heading: { size: 13.5, weight: 850, lineHeight: 21, before: 26, indent: 0 },
  paragraph: { size: 10.5, weight: 450, lineHeight: 18.5, before: 8, indent: 0 },
};

/**
 * The room above a passage that follows `after`: a heading holds its first paragraph close, and a summary's own
 * paragraphs stand as close as a section's.
 */
function roomAbove(kind: Kind, after: Kind | undefined): number {
  if (kind === 'paragraph' && after === 'heading') return 5;
  if (kind === 'summary' && after === 'summary') return TYPE.paragraph.before;
  return TYPE[kind].before;
}

export type Passage = { kind: Kind; text: string };

/** The chapters the reading is printed in. */
export const CHAPTERS = { saju: '사주 풀이', ziwei: '자미두수 풀이' } as const;

function chapterOf(title: string, part: { summary: string; sections: readonly ReadingSection[] }): Passage[] {
  const passages: Passage[] = [
    { kind: 'chapter', text: title },
    ...paragraphsOf(part.summary).map((text): Passage => ({ kind: 'summary', text })),
    ...part.sections.flatMap((section): Passage[] => [
      { kind: 'heading', text: section.title.trim() },
      ...paragraphsOf(section.body).map((text): Passage => ({ kind: 'paragraph', text })),
    ]),
  ];
  return passages.filter((passage) => passage.text);
}

/** The reading in the order it is printed: the 사주's chapter, then the 자미두수's for a birth that has a 명반. */
export function passagesOf(reading: SajuReading): Passage[] {
  return [...chapterOf(CHAPTERS.saju, reading.saju), ...(reading.ziwei ? chapterOf(CHAPTERS.ziwei, reading.ziwei) : [])];
}

/** A passage set in its lines. */
export type SetPassage = Passage & { lines: string[] };

/**
 * The passages set at `width` (less each kind's indent) and laid over pages `height` tall: the lines of each, and what
 * each page holds. `measureIn` gives the measure of a kind's type; it is asked for one passage at a time.
 */
export function setReading(passages: readonly Passage[], width: number, height: number, measureIn: (kind: Kind) => Measure): { passages: SetPassage[]; pages: Placed[][] } {
  const set = passages.map((passage): SetPassage => ({ ...passage, lines: wrap(passage.text, width - TYPE[passage.kind].indent, measureIn(passage.kind)) }));
  const blocks = set.map(
    (passage, index): Block => ({
      lines: passage.lines.length,
      lineHeight: TYPE[passage.kind].lineHeight,
      before: roomAbove(passage.kind, set[index - 1]?.kind),
      breakBefore: passage.kind === 'chapter',
      keepWithNext: passage.kind === 'chapter' || passage.kind === 'heading',
    }),
  );
  return { passages: set, pages: paginate(blocks, height) };
}
