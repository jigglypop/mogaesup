import { describe, expect, it } from 'vitest';

import type { SajuReading } from '../../api/types';
import { KEEP, paginate, type Block, type Placed } from '../report/flow';
import { CHAPTERS, passagesOf, setReading, TYPE, type Kind } from '../report/reading';
import type { Measure } from '../report/wrap';

const paragraph = (lines: number, before = 6): Block => ({ lines, lineHeight: 10, before });
const heading = (lines = 1): Block => ({ lines, lineHeight: 20, before: 12, keepWithNext: true });
const chapter = (): Block => ({ lines: 1, lineHeight: 30, before: 0, breakBefore: true, keepWithNext: true });

/** Where each line of each block went: page by page, block by block, in order. */
const linesOf = (pages: Placed[][]) => pages.flatMap((page, at) => page.flatMap((placed) => Array.from({ length: placed.to - placed.from }, (_, index) => ({ page: at, block: placed.block, line: placed.from + index }))));

/** What every layout keeps: each line once and in order, nothing below a page's foot unless a line is taller than it. */
function expectWhole(blocks: readonly Block[], pages: Placed[][], height: number) {
  const placed = linesOf(pages);
  const expected = blocks.flatMap((block, index) => Array.from({ length: Math.max(0, block.lines) }, (_, line) => ({ block: index, line })));
  expect(placed.map(({ block, line }) => ({ block, line }))).toEqual(expected);
  for (const page of pages) {
    expect(page.length).toBeGreaterThan(0);
    for (const item of page) {
      const block = blocks[item.block]!;
      if (block.lineHeight <= height) expect(item.y + (item.to - item.from) * block.lineHeight).toBeLessThanOrEqual(height + 1e-6);
    }
  }
}

describe('쪽 나누기', () => {
  it('들어가는 만큼 한 쪽에 차례로 놓고, 쪽 맨 위에서는 위 여백을 두지 않는다', () => {
    const blocks = [paragraph(3), paragraph(2), paragraph(4)];
    const pages = paginate(blocks, 200);
    expectWhole(blocks, pages, 200);
    expect(pages).toEqual([
      [
        { block: 0, from: 0, to: 3, y: 0 },
        { block: 1, from: 0, to: 2, y: 36 },
        { block: 2, from: 0, to: 4, y: 62 },
      ],
    ]);
  });

  it('문단을 가를 때 앞 쪽 끝과 다음 쪽 머리에 두 줄 이상씩 남긴다', () => {
    // 7 lines fit under the first paragraph; the second has 8, so one would be left alone on the next page.
    const blocks = [paragraph(2), paragraph(8, 0)];
    const pages = paginate(blocks, 90);
    expectWhole(blocks, pages, 90);
    expect(pages[0]?.at(-1)).toEqual({ block: 1, from: 0, to: 6, y: 20 });
    expect(pages[1]?.[0]).toEqual({ block: 1, from: 6, to: 8, y: 0 });
    for (const page of pages) for (const item of page) if (blocks[item.block]!.lines >= KEEP * 2) expect(item.to - item.from).toBeGreaterThanOrEqual(KEEP);
  });

  it('쪽 끝에 한 줄만 들어가면 문단을 통째로 다음 쪽으로 넘긴다', () => {
    const blocks = [paragraph(8), paragraph(5, 0)];
    const pages = paginate(blocks, 90);
    expectWhole(blocks, pages, 90);
    expect(pages.map((page) => page.map((item) => item.block))).toEqual([[0], [1]]);
    // Three lines are too few to split: they go over whole rather than leave one line behind.
    const short = [paragraph(7), paragraph(3, 0)];
    expect(paginate(short, 90).map((page) => page.map((item) => [item.block, item.from, item.to]))).toEqual([[[0, 0, 7]], [[1, 0, 3]]]);
  });

  it('소제목은 쪽 끝에 홀로 남지 않고 다음 문단의 첫 줄들과 함께 간다', () => {
    const blocks = [paragraph(6), heading(), paragraph(5)];
    // The heading itself fits under the paragraph (60 + 12 + 20), but not with two lines after it.
    const pages = paginate(blocks, 100);
    expectWhole(blocks, pages, 100);
    expect(pages.map((page) => page.map((item) => item.block))).toEqual([[0], [1, 2]]);
    expect(pages[1]?.[0]).toEqual({ block: 1, from: 0, to: 1, y: 0 });
    // With room for both, they stay.
    expect(paginate(blocks, 160).map((page) => page.map((item) => item.block))).toEqual([[0, 1, 2]]);
  });

  it('장은 새 쪽에서 시작한다', () => {
    const blocks = [chapter(), paragraph(2), chapter(), paragraph(2)];
    const pages = paginate(blocks, 500);
    expectWhole(blocks, pages, 500);
    expect(pages.map((page) => page.map((item) => item.block))).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('여러 쪽에 걸친 문단도 줄을 잃지 않고, 쪽보다 큰 줄도 한 쪽을 차지한다', () => {
    const long = [heading(), paragraph(47), paragraph(1), heading(2), paragraph(3)];
    const pages = paginate(long, 100);
    expectWhole(long, pages, 100);
    expect(pages.length).toBeGreaterThan(5);
    const tall = [{ lines: 2, lineHeight: 150, before: 0 }, paragraph(1)];
    const tallPages = paginate(tall, 100);
    expect(tallPages.map((page) => page.map((item) => [item.block, item.from, item.to]))).toEqual([[[0, 0, 1]], [[0, 1, 2]], [[1, 0, 1]]]);
  });

  it('줄이 없는 덩어리는 건너뛴다', () => {
    const blocks = [paragraph(0), paragraph(2), heading(0)];
    expect(paginate(blocks, 100)).toEqual([[{ block: 1, from: 0, to: 2, y: 0 }]]);
    expect(paginate([], 100)).toEqual([]);
  });
});

const READING: SajuReading = {
  saju: {
    summary: '큰 산 같은 사주입니다.\n\n지금은 다듬을 때입니다.',
    sections: [
      { title: ' 타고난 성품 ', body: '첫 문단입니다.\n둘째 문단입니다.' },
      { title: '일과 재물', body: '' },
    ],
  },
  ziwei: { summary: '명궁에 탐랑이 앉았습니다.', sections: [{ title: '명궁', body: '욕망과 재능의 별입니다.' }] },
};

describe('풀이 짜기', () => {
  it('사주 장, 그다음 자미두수 장: 장 제목, 요약 문단, 소제목과 문단', () => {
    expect(passagesOf(READING)).toEqual([
      { kind: 'chapter', text: CHAPTERS.saju },
      { kind: 'summary', text: '큰 산 같은 사주입니다.' },
      { kind: 'summary', text: '지금은 다듬을 때입니다.' },
      { kind: 'heading', text: '타고난 성품' },
      { kind: 'paragraph', text: '첫 문단입니다.' },
      { kind: 'paragraph', text: '둘째 문단입니다.' },
      { kind: 'heading', text: '일과 재물' },
      { kind: 'chapter', text: CHAPTERS.ziwei },
      { kind: 'summary', text: '명궁에 탐랑이 앉았습니다.' },
      { kind: 'heading', text: '명궁' },
      { kind: 'paragraph', text: '욕망과 재능의 별입니다.' },
    ]);
  });

  it('명반이 없는 풀이는 사주 장만 싣는다', () => {
    const passages = passagesOf({ ...READING, ziwei: null });
    expect(passages.filter((passage) => passage.kind === 'chapter').map((passage) => passage.text)).toEqual([CHAPTERS.saju]);
  });

  it('갈래마다 제 글꼴로 재고, 들여 쓴 만큼 좁게 나누어 쪽에 앉힌다', () => {
    const asked: Kind[] = [];
    // Each kind's type at a width of one unit a character and its size in tenths: a test can tell them apart.
    const measureIn = (kind: Kind): Measure => {
      asked.push(kind);
      return (text) => Array.from(text).length * TYPE[kind].size;
    };
    const passages = passagesOf(READING);
    const width = 30 * TYPE.paragraph.size;
    const set = setReading(passages, width, 400, measureIn);
    expect(asked).toEqual(passages.map((passage) => passage.kind));
    for (const passage of set.passages) {
      const room = width - TYPE[passage.kind].indent;
      for (const line of passage.lines) expect(Array.from(line).length * TYPE[passage.kind].size).toBeLessThanOrEqual(room);
      expect(passage.lines.join('').replace(/\s/g, '')).toBe(passage.text.replace(/\s/g, ''));
    }
    // Each chapter on a page of its own, the 자미두수's starting the second.
    expect(set.pages).toHaveLength(2);
    expect(set.passages[set.pages[1]?.[0]?.block ?? -1]?.text).toBe(CHAPTERS.ziwei);
    // A heading's first paragraph stands closer to it than the next paragraph to the one before.
    const firstPage = set.pages[0] ?? [];
    const yOf = (text: string) => firstPage.find((item) => set.passages[item.block]?.text === text)?.y ?? NaN;
    const lineEnd = (text: string) => {
      const item = firstPage.find((placed) => set.passages[placed.block]?.text === text);
      const passage = item && set.passages[item.block];
      return item && passage ? item.y + (item.to - item.from) * TYPE[passage.kind].lineHeight : NaN;
    };
    expect(yOf('첫 문단입니다.') - lineEnd('타고난 성품')).toBeLessThan(yOf('둘째 문단입니다.') - lineEnd('첫 문단입니다.'));
  });
});
