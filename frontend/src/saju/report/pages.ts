import { ELEMENT_NAME, ELEMENTS, branchElement, stemElement, type Element } from '../elements';
import type { Pillar, PillarKey } from '../engine';
import { nayinKo, stageKo } from '../labels';
import type { Profile } from '../profile';
import type { Sahwa, Ziwei, ZiweiPalace, ZiweiStar } from '../ziwei';
import type { Placed } from './flow';
import { A4 } from './pdf';
import { TYPE, type Kind, type SetPassage } from './reading';
import type { Measure } from './wrap';

// The pages of the 팔자피자 PDF, each drawn on a canvas in points from the top left of an A4 sheet (`begin` scales the
// context to the canvas's pixels): the cover, the 사주 원국, the 자미두수 명반 and the reading. The chart pages show
// what the panels show (ui/ChartPanel.tsx, ui/ZiweiPanel.tsx) in their marks and colours, on white paper.

/** A page's canvas: A4 at about 200 dots an inch. */
export const PAGE_PIXELS = { width: Math.round((A4.width * 200) / 72), height: Math.round((A4.height * 200) / 72) } as const;

/** The light theme's colours, which every page is printed in whatever the screen shows. */
export type Colors = {
  ink: string;
  muted: string;
  hair: string;
  tint: string;
  /** The page's own ground, which a label on the ink is written in. */
  surface: string;
  good: string;
  goodSoft: string;
  bad: string;
  warn: string;
  /** The ink of a label on an element's fill. */
  accentInk: string;
  /** Each element's fill, its wash, and text in its tone. */
  elements: Record<Element, { mark: string; soft: string; ink: string }>;
};

/** The colours as `token` reads the app's tokens (`--mg-ink` …). */
export function colorsOf(token: (name: string) => string): Colors {
  const tone = (element: Element) => ({ mark: token(`--mg-${element}`), soft: token(`--mg-${element}-soft`), ink: token(`--mg-${element}-ink`) });
  return {
    ink: token('--mg-ink'),
    muted: token('--mg-muted'),
    hair: token('--mg-hair'),
    tint: token('--mg-tint'),
    surface: token('--mg-surface'),
    good: token('--mg-good'),
    goodSoft: token('--mg-good-soft'),
    bad: token('--mg-bad'),
    warn: token('--mg-warn'),
    accentInk: token('--mg-accent-ink'),
    elements: { wood: tone('wood'), fire: tone('fire'), earth: tone('earth'), metal: tone('metal'), water: tone('water') },
  };
}

/** What a page is drawn with: the canvas's context, the colours, and the app's type and its monospace as CSS families. */
export type Paper = { context: CanvasRenderingContext2D; colors: Colors; font: string; mono: string };

/** The part of a chart page its content takes, in points. */
const CONTENT = { left: 52, width: A4.width - 104, top: 56, bottom: A4.height - 60 } as const;
/** The part of a page of the reading its text takes: a narrower measure, for lines a reader's eye can follow. */
export const READING = { left: 72, width: A4.width - 144, top: 84, height: A4.height - 84 - 82 } as const;
/** White paper. */
const PAPER = '#ffffff';

/** Clears the canvas to white and sets it to draw in points. */
export function begin(paper: Paper): void {
  const { context } = paper;
  const { width, height } = context.canvas;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = PAPER;
  context.fillRect(0, 0, width, height);
  context.setTransform(width / A4.width, 0, 0, height / A4.height, 0, 0);
  context.textBaseline = 'middle';
  context.imageSmoothingQuality = 'high';
  context.setLineDash([]);
}

type Look = { size: number; weight: number; color?: string; align?: CanvasTextAlign; mono?: boolean };

function setType(paper: Paper, look: Look): void {
  const { context } = paper;
  context.font = `${look.weight} ${look.size}px ${look.mono ? paper.mono : paper.font}`;
  context.textAlign = look.align ?? 'left';
  if (look.color) context.fillStyle = look.color;
}

/** How wide `text` is in `look`. */
function widthOf(paper: Paper, text: string, look: Look): number {
  setType(paper, look);
  return paper.context.measureText(text).width;
}

/** Writes `text` with the middle of its line at `y`, and gives the width it took. */
function write(paper: Paper, text: string, x: number, y: number, look: Look): number {
  setType(paper, look);
  paper.context.fillText(text, x, y);
  return paper.context.measureText(text).width;
}

/** `look` made small enough, if it must be, for `text` to fit `width`. */
function fitted(paper: Paper, text: string, look: Look, width: number): Look {
  const full = widthOf(paper, text, look);
  return full <= width ? look : { ...look, size: (look.size * width) / full };
}

/** Lays a rounded box's path. */
function box(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function fillBox(paper: Paper, x: number, y: number, width: number, height: number, radius: number, color: string): void {
  box(paper.context, x, y, width, height, radius);
  paper.context.fillStyle = color;
  paper.context.fill();
}

function strokeBox(paper: Paper, x: number, y: number, width: number, height: number, radius: number, color: string, line: number, dash: number[] = []): void {
  const { context } = paper;
  // The stroke is centred on the path: inset by half of it, it stays inside the box.
  box(context, x + line / 2, y + line / 2, width - line, height - line, Math.max(0, radius - line / 2));
  context.strokeStyle = color;
  context.lineWidth = line;
  context.setLineDash(dash);
  context.stroke();
  context.setLineDash([]);
}

/** A page's heading, on a chart page. */
function heading(paper: Paper, text: string): void {
  write(paper, text, CONTENT.left, CONTENT.top + 11, { size: 20, weight: 850, color: paper.colors.ink });
}

/** A section's name on a chart page, with what it says beside it in quieter type. */
function sectionName(paper: Paper, text: string, x: number, y: number, aside = '', asideColor = paper.colors.muted): void {
  const width = write(paper, text, x, y, { size: 12.5, weight: 850, color: paper.colors.ink });
  if (aside) write(paper, aside, x + width + 6, y + 0.5, { size: 9.5, weight: 700, color: asideColor });
}

/** The page's number among them all, at its foot. */
export function drawFolio(paper: Paper, number: number, total: number): void {
  write(paper, `${number} / ${total}`, A4.width / 2, A4.height - 34, { size: 8.5, weight: 650, color: paper.colors.muted, align: 'center' });
}

/** A picture for the cover: one loaded from its address, or one drawn on a canvas. */
export type Picture = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

/** The size of a picture, in its own pixels. */
const sizeOf = (picture: Picture) => (picture instanceof HTMLImageElement ? { width: picture.naturalWidth, height: picture.naturalHeight } : { width: picture.width, height: picture.height });

export type Cover = {
  name: string;
  /** The 일간 in a line: `따뜻한 촛불 같은 정화(丁火) 일간`. */
  badge: string;
  /** The home's element, which its marks are drawn in. */
  element: Element;
  /** The birth as the chart reads it, a line or two. */
  birth: readonly string[];
  /** The day the PDF is made. */
  date: string;
  /** The home's picture: its 미연시 picture, or the island drawn alone; null when neither could be had. */
  picture: Picture | null;
};

/** The cover: 팔자피자, the home's picture, its name and 일간, the birth, and the day it was printed. */
export function drawCover(paper: Paper, cover: Cover): void {
  const { context, colors } = paper;
  const tone = colors.elements[cover.element];
  const middle = A4.width / 2;

  write(paper, '팔자피자', middle, 74, { size: 17, weight: 850, color: colors.ink, align: 'center' });
  // The five elements' colours under it, in the order each gives rise to the next.
  ELEMENTS.forEach((element, index) => fillBox(paper, middle - 39 + index * 16, 91, 14, 3.5, 1.75, colors.elements[element].mark));

  const side = 420;
  const left = middle - side / 2;
  const top = 114;
  context.save();
  box(context, left, top, side, side, 22);
  context.clip();
  if (cover.picture) {
    // The middle square of a picture that is not square.
    const { width, height } = sizeOf(cover.picture);
    const square = Math.min(width, height);
    context.drawImage(cover.picture, (width - square) / 2, (height - square) / 2, square, square, left, top, side, side);
  } else {
    context.fillStyle = tone.soft;
    context.fillRect(left, top, side, side);
  }
  context.restore();
  strokeBox(paper, left, top, side, side, 22, colors.hair, 0.75);

  const name = fitted(paper, cover.name, { size: 34, weight: 850, color: colors.ink, align: 'center' }, CONTENT.width);
  write(paper, cover.name, middle, top + side + 50, name);

  const badge = fitted(paper, cover.badge, { size: 12.5, weight: 800, color: tone.ink, align: 'center' }, CONTENT.width - 32);
  const badgeWidth = widthOf(paper, cover.badge, badge) + 30;
  fillBox(paper, middle - badgeWidth / 2, top + side + 80, badgeWidth, 28, 14, tone.soft);
  write(paper, cover.badge, middle, top + side + 94.5, badge);

  cover.birth.forEach((line, index) =>
    write(paper, line, middle, top + side + 138 + index * 19, { size: 10.5, weight: index === 0 ? 750 : 650, color: index === 0 ? colors.ink : colors.muted, align: 'center' }),
  );

  write(paper, cover.date, middle, A4.height - 58, { size: 9.5, weight: 650, color: colors.muted, align: 'center' });
}

const PILLAR_LABEL: Record<PillarKey, string> = { year: '년주', month: '월주', day: '일주', hour: '시주' };
/** 시·일·월·년, the order a chart is written in. */
const ORDER: readonly PillarKey[] = ['hour', 'day', 'month', 'year'];
const BLANK = '-';

/** Lays items of the given widths in lines `width` wide: where each one goes, by line and by its left. */
function flowOf(widths: readonly number[], width: number, gap: number): { line: number; x: number }[] {
  let line = 0;
  let x = 0;
  return widths.map((itemWidth) => {
    if (x > 0 && x + itemWidth > width) {
      line += 1;
      x = 0;
    }
    const place = { line, x };
    x += itemWidth + gap;
    return place;
  });
}

/**
 * 사주 원국: the four pillars with their 십성, 지장간, 12운성 and 납음, the balance of the elements, the 신살 the chart
 * holds with the 12신살 of each branch, and the 대운 with the one running now marked. Without a birth hour the hour
 * pillar stands empty.
 */
export function drawChart(paper: Paper, profile: Profile): void {
  const { context, colors } = paper;
  const { reading, balance } = profile;
  const home = colors.elements[balance.dominant];
  const pillars = ORDER.map((key) => ({ key, pillar: reading[key] }));
  const label = 58;
  const column = (CONTENT.width - label) / pillars.length;
  const middleOf = (index: number) => CONTENT.left + label + column * (index + 0.5);
  const rule = (y: number) => {
    context.fillStyle = colors.hair;
    context.fillRect(CONTENT.left, y, CONTENT.width, 0.75);
  };

  heading(paper, '사주 원국');
  let y = CONTENT.top + 34;
  const ROW = 23;
  const GLYPH = 70;
  pillars.forEach(({ key }, index) => write(paper, PILLAR_LABEL[key], middleOf(index), y + ROW / 2, { size: 9.5, weight: 800, color: colors.muted, align: 'center' }));
  y += ROW;
  const textRow = (name: string, cell: (pillar: Pillar) => string) => {
    rule(y);
    write(paper, name, CONTENT.left + 2, y + ROW / 2, { size: 9.5, weight: 800, color: colors.muted });
    pillars.forEach(({ pillar }, index) =>
      write(paper, pillar ? cell(pillar) : BLANK, middleOf(index), y + ROW / 2, { size: 10.5, weight: 650, color: colors.ink, align: 'center' }),
    );
    y += ROW;
  };
  const glyphRow = (name: string, glyph: (pillar: Pillar) => { hanja: string; ko: string; element: Element | null }) => {
    write(paper, name, CONTENT.left + 2, y + GLYPH / 2, { size: 9.5, weight: 800, color: colors.muted });
    pillars.forEach(({ pillar }, index) => {
      if (!pillar) {
        write(paper, BLANK, middleOf(index), y + GLYPH / 2, { size: 10.5, weight: 650, color: colors.ink, align: 'center' });
        return;
      }
      const { hanja, ko, element } = glyph(pillar);
      const tone = element ? colors.elements[element] : { soft: colors.tint, ink: colors.ink };
      fillBox(paper, CONTENT.left + label + column * index + 4, y + 3, column - 8, GLYPH - 6, 10, tone.soft);
      write(paper, hanja, middleOf(index), y + GLYPH * 0.42, { size: 27, weight: 800, color: tone.ink, align: 'center' });
      write(paper, ko, middleOf(index), y + GLYPH * 0.78, { size: 10, weight: 750, color: tone.ink, align: 'center' });
    });
    y += GLYPH;
  };
  textRow('십성', (pillar) => pillar.shiShenGan);
  glyphRow('천간', (pillar) => ({ hanja: pillar.stem, ko: pillar.stemKo, element: stemElement(pillar.stem) }));
  glyphRow('지지', (pillar) => ({ hanja: pillar.branch, ko: pillar.branchKo, element: branchElement(pillar.branch) }));
  textRow('십성', (pillar) => pillar.shiShenBranch);
  textRow('지장간', (pillar) => pillar.hideGanKo);
  textRow('12운성', (pillar) => stageKo(pillar.diShi));
  textRow('납음', (pillar) => nayinKo(pillar.nayin));

  // 오행 밸런스 on the left; the 신살 on the right.
  y += 26;
  const gauge = { left: CONTENT.left, width: 206 };
  const charms = { left: CONTENT.left + gauge.width + 26, width: CONTENT.width - gauge.width - 26 };
  sectionName(paper, '오행 밸런스', gauge.left, y);
  ELEMENTS.forEach((element, index) => {
    const tone = colors.elements[element];
    const middle = y + 26 + index * 21;
    const { ko, hanja } = ELEMENT_NAME[element];
    const nameWidth = write(paper, ko, gauge.left, middle, { size: 11, weight: 800, color: tone.ink });
    write(paper, hanja, gauge.left + nameWidth + 3, middle + 0.5, { size: 8.5, weight: 650, color: tone.ink });
    const bar = { left: gauge.left + 32, width: gauge.width - 32 - 36 };
    const gap = 2.5;
    const cell = (bar.width - gap * (balance.total - 1)) / Math.max(1, balance.total);
    for (let index = 0; index < balance.total; index += 1) {
      fillBox(paper, bar.left + index * (cell + gap), middle - 5.5, cell, 11, 2.5, index < balance.counts[element] ? tone.mark : colors.tint);
    }
    write(paper, `${balance.percent[element]}%`, gauge.left + gauge.width, middle, { size: 9.5, weight: 700, color: colors.ink, align: 'right', mono: true });
  });
  const gaugeBottom = y + 26 + 4 * 21 + 10;

  const matched = reading.sinsal.checks.filter((check) => check.matched);
  sectionName(paper, '신살', charms.left, y, String(matched.length), home.ink);
  const chip = { height: 20, pad: 8, gap: 4.5 };
  const name: Look = { size: 9.5, weight: 750 };
  const where: Look = { size: 7.5, weight: 700 };
  const chips = matched.map((check) => {
    const pillarsOf = check.matchedPillars.map((key) => PILLAR_LABEL[key][0]).join('·');
    const width = chip.pad * 2 + widthOf(paper, check.name, name) + (pillarsOf ? 3 + widthOf(paper, pillarsOf, where) : 0);
    return { check, pillarsOf, width };
  });
  const places = flowOf(
    chips.map((item) => item.width),
    charms.width,
    chip.gap,
  );
  const chipsTop = y + 15;
  chips.forEach(({ check, pillarsOf, width }, index) => {
    const place = places[index];
    if (!place) return;
    const top = chipsTop + place.line * (chip.height + chip.gap);
    const lucky = check.category === '귀인';
    fillBox(paper, charms.left + place.x, top, width, chip.height, chip.height / 2, lucky ? colors.goodSoft : colors.tint);
    const color = lucky ? colors.good : colors.ink;
    const nameWidth = write(paper, check.name, charms.left + place.x + chip.pad, top + chip.height / 2, { ...name, color });
    if (pillarsOf) write(paper, pillarsOf, charms.left + place.x + chip.pad + nameWidth + 3, top + chip.height / 2 + 0.5, { ...where, color: lucky ? colors.good : colors.muted });
  });
  if (matched.length === 0) write(paper, '해당하는 신살이 없어요', charms.left, chipsTop + chip.height / 2, { size: 10, weight: 650, color: colors.muted });
  const lines = matched.length === 0 ? 1 : (places.at(-1)?.line ?? 0) + 1;
  const charmsBottom = chipsTop + lines * (chip.height + chip.gap) + 6;
  y = Math.max(gaugeBottom, charmsBottom) + 8;

  // 12신살: each branch's, counted from the year branch and from the day branch, under the pillars' own columns.
  write(paper, '12신살', CONTENT.left + 2, y + ROW / 2, { size: 9.5, weight: 800, color: colors.muted });
  pillars.forEach(({ key }, index) => write(paper, `${PILLAR_LABEL[key][0]}지`, middleOf(index), y + ROW / 2, { size: 9.5, weight: 800, color: colors.muted, align: 'center' }));
  y += ROW;
  for (const basis of ['yearBasis', 'dayBasis'] as const) {
    rule(y);
    write(paper, basis === 'yearBasis' ? '년지 기준' : '일지 기준', CONTENT.left + 2, y + ROW / 2, { size: 9.5, weight: 800, color: colors.muted });
    pillars.forEach(({ key }, index) => {
      const value = reading.sinsal.twelve.find((cell) => cell.pillar === key)?.[basis] ?? BLANK;
      write(paper, value, middleOf(index), y + ROW / 2, { size: 10.5, weight: 650, color: colors.ink, align: 'center' });
    });
    y += ROW;
  }

  // 대운, seven to a row, the one running now in the home's wash with a dark edge.
  y += 26;
  sectionName(paper, '대운', CONTENT.left, y, `${reading.daYunStart} · ${reading.forward ? '순행' : '역행'}`);
  const daYun = reading.daYun.map((item, index) => ({ item, index })).filter(({ item }) => item.ganZhi);
  const PER_ROW = 7;
  const gap = 6;
  const cell = { width: (CONTENT.width - gap * (PER_ROW - 1)) / PER_ROW, height: 50 };
  daYun.forEach(({ item, index }, place) => {
    const x = CONTENT.left + (place % PER_ROW) * (cell.width + gap);
    const top = y + 16 + Math.floor(place / PER_ROW) * (cell.height + gap);
    const current = index === reading.currentDaYun;
    fillBox(paper, x, top, cell.width, cell.height, 10, current ? home.soft : colors.tint);
    if (current) strokeBox(paper, x, top, cell.width, cell.height, 10, colors.ink, 1.5);
    const middle = x + cell.width / 2;
    write(paper, item.ganZhiKo, middle, top + 15, { size: 12, weight: 850, color: colors.ink, align: 'center' });
    write(paper, item.ganZhi, middle, top + 29, { size: 9, weight: 650, color: colors.muted, align: 'center' });
    write(paper, `${item.startAge}–${item.endAge}세`, middle, top + 40.5, { size: 7.5, weight: 650, color: colors.muted, align: 'center', mono: true });
  });
}

/** 사화 squares, in the colours the panel gives them. */
const SAHWA_ELEMENT: Record<Sahwa, Element> = { 록: 'wood', 권: 'earth', 과: 'water', 기: 'fire' };

/** A star's pieces as a cell writes them: its name, how bright it stands, its 사화. */
type StarLook = { size: number; weight: number; color: string; brightness: boolean };

function starWidth(paper: Paper, star: ZiweiStar, look: StarLook): number {
  let width = widthOf(paper, star.name, look);
  if (look.brightness && star.brightness) width += 1.5 + widthOf(paper, star.brightness, { size: Math.max(6.5, look.size * 0.72), weight: 700 });
  if (star.sahwa) width += 2 + look.size * 1.2;
  return width;
}

function drawStar(paper: Paper, star: ZiweiStar, x: number, y: number, look: StarLook): void {
  const { colors } = paper;
  let at = x + write(paper, star.name, x, y, look);
  if (look.brightness && star.brightness) {
    at += 1.5;
    at += write(paper, star.brightness, at, y + 0.5, { size: Math.max(6.5, look.size * 0.72), weight: 700, color: colors.muted });
  }
  if (star.sahwa) {
    const side = look.size * 1.2;
    at += 2;
    fillBox(paper, at, y - side / 2, side, side, side * 0.27, colors.elements[SAHWA_ELEMENT[star.sahwa]].mark);
    write(paper, star.sahwa, at + side / 2, y + 0.3, { size: look.size * 0.78, weight: 850, color: colors.accentInk, align: 'center' });
  }
}

/** Stars in lines across `width` from (`x`, `top`), each line `lineHeight` tall; the height they took. */
function drawStars(paper: Paper, stars: readonly ZiweiStar[], x: number, top: number, width: number, lineHeight: number, look: (star: ZiweiStar) => StarLook): number {
  if (stars.length === 0) return 0;
  const places = flowOf(
    stars.map((star) => starWidth(paper, star, look(star))),
    width,
    5,
  );
  stars.forEach((star, index) => {
    const place = places[index];
    if (place) drawStar(paper, star, x + place.x, top + (place.line + 0.5) * lineHeight, look(star));
  });
  return ((places.at(-1)?.line ?? 0) + 1) * lineHeight;
}

/** How a palace stands to the 명궁, whose 삼방사정 the page marks as the panel does when it opens. */
type Relation = 'self' | 'trine' | 'opposite';

/**
 * Where a ring cell's row (or column) meets the square in the middle of the ring, in hundredths of its side, as the
 * panel draws the 삼방사정's lines.
 */
const EDGE = [0, 25, 75, 100] as const;

/** Room round a faded drawing for its strokes, which reach past the area they are drawn about. */
const BLEED = 4;

/**
 * Draws `draw` (in the page's points) faint in the middle of `area` and at full strength at its edge, as the panel's
 * mask does: `radial-gradient(closest-side, rgba(0, 0, 0, 0.14) 58%, #000 100%)` over the area.
 */
function faded(paper: Paper, area: { x: number; y: number; width: number; height: number }, draw: (context: CanvasRenderingContext2D) => void): void {
  const scale = paper.context.getTransform().a;
  const layer = document.createElement('canvas');
  layer.width = Math.ceil((area.width + BLEED * 2) * scale);
  layer.height = Math.ceil((area.height + BLEED * 2) * scale);
  const context = layer.getContext('2d');
  if (!context) return;
  context.setTransform(scale, 0, 0, scale, (BLEED - area.x) * scale, (BLEED - area.y) * scale);
  draw(context);
  // In the units of the ellipse `closest-side` draws in the area: its middle at 0, its edge at 1.
  context.setTransform((area.width / 2) * scale, 0, 0, (area.height / 2) * scale, (BLEED + area.width / 2) * scale, (BLEED + area.height / 2) * scale);
  const mask = context.createRadialGradient(0, 0, 0, 0, 0, 1);
  mask.addColorStop(0.58, 'rgba(0, 0, 0, 0.14)');
  mask.addColorStop(1, 'rgba(0, 0, 0, 1)');
  context.globalCompositeOperation = 'destination-in';
  context.fillStyle = mask;
  context.fillRect(-2, -2, 4, 4);
  paper.context.drawImage(layer, area.x - BLEED, area.y - BLEED, area.width + BLEED * 2, area.height + BLEED * 2);
}

/**
 * 자미두수 명반: the twelve palaces round the ring by earthly branch, each with its stars (주성 with brightness and 사화,
 * then 보좌·길성, 살성, 록존·천마 and 잡성), its 12신 and its 대한; the 명궁's 삼방사정 marked; in the middle the
 * 오행국, 명궁, 신궁, 명주, 신주, the lunar birth date and the 시진.
 */
export function drawZiwei(paper: Paper, ziwei: Ziwei, element: Element): void {
  const { context, colors } = paper;
  const home = colors.elements[element];
  heading(paper, '자미두수 명반');
  const gap = 5;
  const top = CONTENT.top + 36;
  const cell = { width: (CONTENT.width - gap * 3) / 4, height: (CONTENT.bottom - top - gap * 3) / 4 };
  const xOf = (col: number) => CONTENT.left + col * (cell.width + gap);
  const yOf = (row: number) => top + row * (cell.height + gap);

  const picked = ziwei.palaces[ziwei.soul];
  const relationOf = (index: number): Relation | null => {
    if (!picked) return null;
    if (index === picked.index) return 'self';
    if (picked.surround?.trines.includes(index)) return 'trine';
    return picked.surround?.opposite === index ? 'opposite' : null;
  };

  // The 삼방사정's lines in the square the ring leaves in the middle, under the summary, faint towards the middle as
  // the panel masks them; their ends stand over the mask, at full strength.
  const square = { x: xOf(1) - gap, y: yOf(1) - gap, width: cell.width * 2 + gap * 3, height: cell.height * 2 + gap * 3 };
  const pointOf = (palace: ZiweiPalace) => ({ x: square.x + ((EDGE[palace.col] ?? 50) / 100) * square.width, y: square.y + ((EDGE[palace.row] ?? 50) / 100) * square.height });
  if (picked?.surround) {
    const from = pointOf(picked);
    const trines = picked.surround.trines.flatMap((index) => ziwei.palaces[index] ?? []).map(pointOf);
    const across = ziwei.palaces[picked.surround.opposite];
    const to = across ? pointOf(across) : null;
    faded(paper, square, (layer) => {
      layer.beginPath();
      [from, ...trines].forEach(({ x, y }, index) => (index === 0 ? layer.moveTo(x, y) : layer.lineTo(x, y)));
      layer.closePath();
      layer.fillStyle = home.soft;
      layer.fill();
      layer.strokeStyle = home.ink;
      layer.lineWidth = 1;
      layer.lineJoin = 'round';
      layer.stroke();
      if (to) {
        layer.beginPath();
        layer.moveTo(from.x, from.y);
        layer.lineTo(to.x, to.y);
        layer.setLineDash([3, 4]);
        layer.stroke();
      }
    });
    context.fillStyle = home.ink;
    for (const { x, y } of [from, ...trines, ...(to ? [to] : [])]) {
      context.beginPath();
      context.arc(x, y, 2.6, 0, Math.PI * 2);
      context.fill();
    }
  }

  for (const palace of ziwei.palaces) drawPalace(paper, palace, xOf(palace.col), yOf(palace.row), cell.width, cell.height, relationOf(palace.index), element);
  drawCentre(paper, ziwei, { x: xOf(1), y: yOf(1), width: cell.width * 2 + gap, height: cell.height * 2 + gap });
}

const STAR_COLOR = (colors: Colors, star: ZiweiStar): string =>
  ({ major: colors.ink, lucky: colors.good, tough: colors.bad, special: colors.warn, misc: colors.muted })[star.kind];

function drawPalace(paper: Paper, palace: ZiweiPalace, x: number, y: number, width: number, height: number, relation: Relation | null, element: Element): void {
  const { context, colors } = paper;
  const home = colors.elements[element];
  fillBox(paper, x, y, width, height, 9, relation ? home.soft : colors.tint);
  if (relation === 'self') strokeBox(paper, x, y, width, height, 9, colors.ink, 1.5);
  else if (relation) strokeBox(paper, x, y, width, height, 9, home.ink, 1, relation === 'opposite' ? [3, 2.5] : []);
  else strokeBox(paper, x, y, width, height, 9, colors.hair, 0.75);

  const pad = 7;
  const inner = { left: x + pad, width: width - pad * 2 };
  context.save();
  box(context, x, y, width, height, 9);
  context.clip();

  // The head: the palace (the 명궁 on the home's fill), what else it is, and its 간지.
  const head = y + pad + 6.5;
  const nameLook: Look = { size: 11.5, weight: 850 };
  let at = inner.left;
  if (palace.isSoul) {
    const nameWidth = widthOf(paper, palace.name, nameLook);
    fillBox(paper, at - 3, head - 8, nameWidth + 6, 16, 4, home.mark);
    at += write(paper, palace.name, at, head, { ...nameLook, color: colors.accentInk }) + 7;
  } else {
    at += write(paper, palace.name, at, head, { ...nameLook, color: colors.ink }) + 5;
  }
  for (const flag of [palace.isBody && '신궁', palace.isOrigin && '래인궁'].filter((value): value is string => !!value)) {
    const flagLook: Look = { size: 7.5, weight: 800, color: home.ink };
    const flagWidth = widthOf(paper, flag, flagLook) + 6;
    strokeBox(paper, at, head - 6.5, flagWidth, 13, 3.5, home.ink, 0.75);
    write(paper, flag, at + flagWidth / 2, head + 0.3, { ...flagLook, align: 'center' });
    at += flagWidth + 3;
  }
  const ganjiLook: Look = { size: 8, weight: 650, color: colors.muted, align: 'right' };
  const hanjaWidth = palace.ganji.hanja ? write(paper, palace.ganji.hanja, inner.left + inner.width, head + 0.3, ganjiLook) + 2.5 : 0;
  // A head with no room for both keeps the 한자 of the 간지 and lets the Korean go.
  if (at + hanjaWidth + widthOf(paper, palace.ganji.ko, ganjiLook) <= inner.left + inner.width) write(paper, palace.ganji.ko, inner.left + inner.width - hanjaWidth, head + 0.3, ganjiLook);

  let cursor = head + 11;
  const { stars } = palace;
  cursor += drawStars(paper, stars.major, inner.left, cursor, inner.width, 17, () => ({ size: 12.5, weight: 800, color: colors.ink, brightness: true }));
  cursor += 3;
  const minor = [...stars.lucky, ...stars.tough, ...stars.special];
  cursor += drawStars(paper, minor, inner.left, cursor, inner.width, 13.5, (star) => ({ size: 9.5, weight: 750, color: STAR_COLOR(colors, star), brightness: true }));
  cursor += 3;
  drawStars(paper, stars.misc, inner.left, cursor, inner.width, 11.5, (star) => ({ size: 8, weight: 650, color: STAR_COLOR(colors, star), brightness: false }));

  // The foot: its 대한 (the one running now filled with the ink), and the four cycles' names.
  const foot = y + height - pad - 5;
  if (palace.decade) {
    const decade = `${palace.decade.from}–${palace.decade.to}`;
    const decadeLook: Look = { size: 8, weight: 650, mono: true };
    if (palace.isCurrent) {
      const decadeWidth = widthOf(paper, decade, decadeLook);
      fillBox(paper, inner.left - 2.5, foot - 6.5, decadeWidth + 5, 13, 3.5, colors.ink);
      write(paper, decade, inner.left, foot + 0.3, { ...decadeLook, color: colors.surface });
    } else {
      write(paper, decade, inner.left, foot + 0.3, { ...decadeLook, color: colors.muted });
    }
  }
  const cycles = palace.cycles.map((item) => item.name);
  const cycleLook: Look = { size: 7, weight: 650, color: colors.muted, align: 'right' };
  const oneLine = cycles.join(' ');
  if (widthOf(paper, oneLine, cycleLook) <= inner.width - 32) {
    write(paper, oneLine, inner.left + inner.width, foot + 0.3, cycleLook);
  } else {
    // Two and two, as the panel sets a line too long for the cell.
    write(paper, cycles.slice(0, 2).join(' '), inner.left + inner.width, foot - 9, cycleLook);
    write(paper, cycles.slice(2).join(' '), inner.left + inner.width, foot + 0.3, cycleLook);
  }
  context.restore();
}

/** The middle of the ring: the 오행국 and the chart's summary on a ground of their own. */
function drawCentre(paper: Paper, ziwei: Ziwei, area: { x: number; y: number; width: number; height: number }): void {
  const { colors } = paper;
  const soul = ziwei.palaces[ziwei.soul];
  const body = ziwei.body === null ? null : ziwei.palaces[ziwei.body];
  const pairs: [string, string][][] = [
    [
      ['명궁', soul?.ganji.ko ?? BLANK],
      ['신궁', body?.ganji.ko ?? BLANK],
    ],
    [
      ['명주', ziwei.soulStar],
      ['신주', ziwei.bodyStar],
    ],
  ];
  const long: [string, string][] = [
    ['음력', ziwei.lunarDate],
    ['시진', [ziwei.hour.name, ziwei.hour.range].filter(Boolean).join(' ')],
  ];
  const term: Look = { size: 8.5, weight: 750, color: colors.muted };
  const value: Look = { size: 11, weight: 800, color: colors.ink };
  const pairWidth = (pair: [string, string]) => widthOf(paper, pair[0], term) + 5 + widthOf(paper, pair[1], value);
  const columns = [0, 1].map((index) => Math.max(...pairs.map((row) => pairWidth(row[index] ?? ['', '']))));
  const rowsWidth = Math.max((columns[0] ?? 0) + 16 + (columns[1] ?? 0), ...long.map(pairWidth));
  const bureau: Look = { size: 25, weight: 850, color: ziwei.bureau.element ? colors.elements[ziwei.bureau.element].ink : colors.ink, align: 'center' };
  const width = Math.min(area.width - 24, Math.max(rowsWidth, widthOf(paper, ziwei.bureau.name, bureau)) + 36);
  const ROW = 19;
  const height = 22 + 34 + ROW * (pairs.length + long.length) + 8;
  const left = area.x + (area.width - width) / 2;
  const top = area.y + (area.height - height) / 2;
  fillBox(paper, left, top, width, height, 12, PAPER);
  strokeBox(paper, left, top, width, height, 12, colors.hair, 0.75);
  const middle = left + width / 2;
  write(paper, ziwei.bureau.name, middle, top + 30, bureau);
  let y = top + 22 + 34 + ROW / 2;
  const start = middle - rowsWidth / 2;
  const writePair = (pair: [string, string], x: number) => {
    const termWidth = write(paper, pair[0], x, y + 0.5, term);
    write(paper, pair[1], x + termWidth + 5, y, value);
  };
  for (const row of pairs) {
    row.forEach((pair, index) => writePair(pair, index === 0 ? start : start + (columns[0] ?? 0) + 16));
    y += ROW;
  }
  for (const pair of long) {
    writePair(pair, start);
    y += ROW;
  }
}

/** The measure of a kind of the reading's type. */
export function measureIn(paper: Paper, kind: Kind): Measure {
  setType(paper, TYPE[kind]);
  return (text) => paper.context.measureText(text).width;
}

/**
 * A page of the reading: the lines `placed` on it, each kind in its type. A chapter's title has the home's colour over
 * it, a summary a bar of it down its side, and a section's heading is written in it.
 */
export function drawReading(paper: Paper, passages: readonly SetPassage[], placed: readonly Placed[], element: Element): void {
  const { colors } = paper;
  const tone = colors.elements[element];
  for (const chunk of placed) {
    const passage = passages[chunk.block];
    if (!passage) continue;
    const type = TYPE[passage.kind];
    const top = READING.top + chunk.y;
    if (passage.kind === 'chapter' && chunk.from === 0) fillBox(paper, READING.left, top - 14, 30, 4, 2, tone.mark);
    if (passage.kind === 'summary') fillBox(paper, READING.left, top + 3, 3, (chunk.to - chunk.from) * type.lineHeight - 6, 1.5, tone.mark);
    const look: Look = { size: type.size, weight: type.weight, color: passage.kind === 'heading' ? tone.ink : colors.ink };
    for (let index = chunk.from; index < chunk.to; index += 1) {
      write(paper, passage.lines[index] ?? '', READING.left + type.indent, top + (index - chunk.from + 0.5) * type.lineHeight, look);
    }
  }
}
