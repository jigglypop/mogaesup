import type { SajuReading } from '../../api/types';
import { chartOf, type Birth, type Reading } from '../engine';
import { profileOf } from '../profile';
import { ziweiOf } from '../ziwei';
import { begin, colorsOf, drawChart, drawCover, drawFolio, drawReading, drawZiwei, measureIn, PAGE_PIXELS, READING, type Paper, type Picture } from './pages';
import { jpegOf, pdfOf } from './pdf';
import { passagesOf, setReading } from './reading';

// 팔자피자: a home's chart and its reading as a PDF to keep, made in the browser. Each page is drawn on a canvas in the
// app's type, kept as a JPEG, and the JPEGs are put together as the pages of the PDF.

export type ReportInput = {
  /** The home's name. */
  name: string;
  birth: Birth;
  reading: SajuReading;
  /** For the cover: the home's 미연시 picture, or the island drawn alone. */
  picture: Picture | null;
  /** The day it is made on (now, unless a test says otherwise). */
  made?: Date;
};

/** How much of a page's detail its JPEG keeps: enough for small type at 200 dpi to stay sharp. */
const QUALITY = 0.9;
/** The weights the pages are set in: the app's type is one variable font, but each weight is asked for. */
const WEIGHTS = [450, 650, 700, 750, 800, 850] as const;

const GENDER = { female: '여성', male: '남성' } as const;
const dateKo = (year: number, month: number, day: number, leap = false) => `${year}년 ${leap ? '윤' : ''}${month}월 ${day}일`;

/**
 * The birth as the chart reads it: as it was entered (the calendar, the date, the hour or that it is not known,
 * gender), then the same day in the other calendar and the 시진 the hour falls in.
 */
export function birthLinesOf(birth: Birth, reading: Reading): string[] {
  const lunar = birth.calendar === 'lunar';
  const entered = `${lunar ? '음력' : '양력'} ${dateKo(birth.year, birth.month, birth.day, lunar && birth.leapMonth)}`;
  const first = `${entered}${birth.time ? ` ${birth.time}` : ' · 시간 모름'} · ${GENDER[birth.gender]}`;
  let other: string | null = null;
  if (lunar) {
    const [year = 0, month = 0, day = 0] = reading.solarDate.split('-').map(Number);
    other = `양력 ${dateKo(year, month, day)}`;
  } else {
    const date = chartOf(birth).rawDates?.lunarDate;
    if (date) other = `음력 ${dateKo(date.lunarYear, date.lunarMonth, date.lunarDay, date.isLeap)}`;
  }
  const second = [other, ziweiOf(birth)?.hour.name].filter(Boolean).join(' · ');
  return second ? [first, second] : [first];
}

/** `2026년 11월 15일`, by Seoul's calendar as the charts are. */
export const madeOn = (date: Date) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' }).format(date);

const computed = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Reads the light theme's tokens: what the stylesheets give `:root` itself (the dark theme's values are set on
 * `:root[data-theme='dark']`), or failing that what the page has now.
 */
function lightTokens(): (name: string) => string {
  const light = new Map<string, string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // Another origin's sheet keeps its rules to itself; the app's tokens are not in one.
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || rule.selectorText !== ':root') continue;
      for (let index = 0; index < rule.style.length; index += 1) {
        const name = rule.style.item(index);
        if (name.startsWith('--mg-')) light.set(name, rule.style.getPropertyValue(name).trim());
      }
    }
  }
  return (name) => light.get(name) || computed(name);
}

/** Waits for the app's type in every weight the pages use: a canvas draws in whatever has loaded when it draws. */
async function typeLoaded(font: string): Promise<void> {
  if (!document.fonts) return;
  await Promise.all(WEIGHTS.map((weight) => document.fonts.load(`${weight} 12px ${font}`, '가甲').catch(() => [])));
  await document.fonts.ready;
}

const jpegFrom = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('a page could not be kept as a JPEG'))), 'image/jpeg', QUALITY));

/** Every page of the PDF as a JPEG, in order: the cover, the 사주 원국, the 명반 for a birth with an hour, the reading. */
export async function pagesOf(input: ReportInput): Promise<Blob[]> {
  const font = computed('--mg-font') || 'sans-serif';
  await typeLoaded(font);
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_PIXELS.width;
  canvas.height = PAGE_PIXELS.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('2D canvas is not available');
  const paper: Paper = { context, colors: colorsOf(lightTokens()), font, mono: computed('--mg-mono') || 'monospace' };

  const profile = profileOf(input.birth);
  const ziwei = ziweiOf(input.birth);
  const element = profile.balance.dominant;
  const reading = setReading(passagesOf(input.reading), READING.width, READING.height, (kind) => measureIn(paper, kind));
  const made = input.made ?? new Date();
  const draws: ((page: Paper) => void)[] = [
    (page) =>
      drawCover(page, {
        name: input.name,
        badge: profile.badge,
        element,
        birth: birthLinesOf(input.birth, profile.reading),
        date: madeOn(made),
        picture: input.picture,
      }),
    (page) => drawChart(page, profile),
    ...(ziwei ? [(page: Paper) => drawZiwei(page, ziwei, element)] : []),
    ...reading.pages.map((placed) => (page: Paper) => drawReading(page, reading.passages, placed, element)),
  ];
  const pages: Blob[] = [];
  for (const [index, draw] of draws.entries()) {
    begin(paper);
    draw(paper);
    // The cover goes without its number.
    if (index > 0) drawFolio(paper, index + 1, draws.length);
    pages.push(await jpegFrom(canvas));
  }
  return pages;
}

/** The PDF of a home's chart and reading. */
export async function reportOf(input: ReportInput): Promise<Blob> {
  const pages = await Promise.all((await pagesOf(input)).map(async (page) => jpegOf(new Uint8Array(await page.arrayBuffer()))));
  const pdf = pdfOf(pages, { title: `${input.name} · 팔자피자`, created: input.made ?? new Date() });
  return new Blob([pdf], { type: 'application/pdf' });
}

/** The file a home's PDF is saved as: `<name>-팔자피자.pdf`, with what a file system would refuse taken out of the name. */
export function reportFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  return `${safe ? `${safe}-` : ''}팔자피자.pdf`;
}

/** The picture at `url`, loaded and decoded; it may be served from another origin that allows it. */
export async function pictureAt(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = url;
  await image.decode();
  return image;
}
