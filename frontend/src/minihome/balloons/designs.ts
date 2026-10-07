import designs from './designs.json';

/**
 * A speech balloon design: its id (the server keeps the same list, server/src/homes.rs `BALLOONS`), its name in the
 * picker, and the room colour it travels as (`accent`). The room hands each person's colour to everyone, so a balloon
 * is told apart by its colour alone; the default has none, and its people keep their own colour.
 */
export type BalloonDesign = { id: string; label: string; accent: string | null };

export const BALLOON_DESIGNS: readonly BalloonDesign[] = designs;
export const DEFAULT_BALLOON = 'glass';

/**
 * A room colour in one spelling, `#rrggbb` in lower case: the room passes `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`
 * alike, so the short forms are written out and an alpha that hides nothing (`ff`) is dropped. Null for anything else,
 * a see-through colour among them.
 */
export function canonicalColor(color: unknown): string | null {
  if (typeof color !== 'string') return null;
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(color.trim().toLowerCase());
  if (!match) return null;
  const digits = match[1]!.length <= 4 ? [...match[1]!].map((digit) => digit + digit).join('') : match[1]!;
  if (digits.length === 8 && !digits.endsWith('ff')) return null;
  return `#${digits.slice(0, 6)}`;
}

const byAccent = new Map(
  BALLOON_DESIGNS.flatMap((design) => {
    const accent = canonicalColor(design.accent);
    return accent ? [[accent, design.id] as const] : [];
  }),
);

/** `id` when it is a design this app draws, else the default (an older server sends none, a newer one may know more). */
export const balloonOf = (id: unknown): string =>
  typeof id === 'string' && BALLOON_DESIGNS.some((design) => design.id === id) ? id : DEFAULT_BALLOON;

/** The room colour a design is sent as; null for the default, whose people keep their own colour. */
export const balloonAccent = (id: unknown): string | null =>
  BALLOON_DESIGNS.find((design) => design.id === id)?.accent ?? null;

/**
 * The colours people talking in the default balloon join the room in, one by their account. None of them is a design's
 * (designs.test.ts keeps it so): whoever talks in the default is never drawn in another design.
 */
export const PERSON_COLORS: readonly string[] = ['#ff7a59', '#8b6cf0', '#2bb3a3', '#e89b16', '#5a8acf', '#e5534b'];
const personColor = (userId: string) =>
  PERSON_COLORS[[...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % PERSON_COLORS.length]!;

/** The colour someone joins the room in: their balloon's, or with the default balloon their own. */
export const roomColor = (balloon: unknown, userId: string): string => balloonAccent(balloon) ?? personColor(userId);

/**
 * The design a room colour stands for: the one whose colour it is, however it is spelled; any other colour (the
 * default's per-person ones, an old page's) is the default. Never the nearest: a colour close to a design's is not
 * that design, so two near colours cannot stand for one design, and no answer depends on the list's order.
 */
export const designOfColor = (color: unknown): string => byAccent.get(canonicalColor(color) ?? '') ?? DEFAULT_BALLOON;

/** How long a line stays up, in ms: longer lines longer, from 2.6 to 8 seconds. */
export const balloonTtl = (text: string): number => Math.min(8000, Math.max(2600, 1200 + 110 * [...text.trim()].length));

const DARK_INK = '#1d1830';
const LIGHT_INK = '#ffffff';
/**
 * Between the brightest of the six colours people get by default (#e89b16, 0.41) and the light accents (외침 0.44,
 * 비눗방울 0.50): the six keep their white initials, the light accents take dark ones.
 */
const BRIGHT = 0.42;

const linear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);

/** Relative luminance (WCAG) of `#rgb` or `#rrggbb`, alpha ignored; null for anything else. */
export function luminance(hex: string): number | null {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!match) return null;
  const digits = match[1]!;
  const short = digits.length <= 4;
  const channel = (index: number) =>
    linear(parseInt(short ? digits[index]!.repeat(2) : digits.slice(index * 2, index * 2 + 2), 16) / 255);
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** The letter colour that reads on `hex`: dark on light colours, white on the rest. */
export const readableInk = (hex: string): string => ((luminance(hex) ?? 0) > BRIGHT ? DARK_INK : LIGHT_INK);
