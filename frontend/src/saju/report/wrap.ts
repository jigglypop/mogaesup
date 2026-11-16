// Korean line breaking for the printed reading. A line may end between any two syllables (or 한자), as Korean is set
// in print, and after a space. A run of letters or digits stays whole and stays with the syllable written against it
// (`2026년`, `GPT가`). Closing marks never begin a line and opening marks never end one: each stays with the
// character it belongs to and goes over to the next line with it.

/** The width `text` takes in the type it will be drawn in. */
export type Measure = (text: string) => number;

/** What may not begin a line: closing brackets and quotes, and the marks that end or divide a phrase. */
const NO_START = new Set([...'!),.:;?]}·…‥’”」』〉》】〕〗〙〛、。，．！？：；）］｝＞％%~～ㆍ']);
/** What may not end a line: opening brackets and quotes. */
const NO_END = new Set([...'([{‘“「『〈《【〔〖〘〚（［｛＜']);

const isSpace = (character: string) => /\s/.test(character);

/** Hangul (syllables and jamo), 한자, kana and the full-width forms: a line may break between any two of these. */
function isWide(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x3134f)
  );
}

/** Whether a line may end between `before` and `after`. */
function breaksBetween(before: string, after: string): boolean {
  if (isSpace(after) || NO_START.has(after) || NO_END.has(before)) return false;
  if (isSpace(before)) return true;
  if (isWide(before) && isWide(after)) return true;
  // After a closing mark, or before an opening one, where it meets a syllable or another such mark.
  if (NO_START.has(before)) return isWide(after) || NO_END.has(after);
  if (NO_END.has(after)) return isWide(before);
  return false;
}

/** `text` cut where a line may end: each piece is what must go on one line, with the spaces after it. */
export function piecesOf(text: string): string[] {
  const characters = Array.from(text);
  const pieces: string[] = [];
  let piece = '';
  characters.forEach((character, index) => {
    const before = characters[index - 1];
    if (before !== undefined && breaksBetween(before, character)) {
      pieces.push(piece);
      piece = '';
    }
    piece += character;
  });
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * A piece too wide for a line by itself (a long run of letters), cut by characters: each part as much as fits, and a
 * closing mark kept off the start of a part where the part before it can give it up.
 */
function cut(piece: string, width: number, measure: Measure): string[] {
  const characters = Array.from(piece);
  const parts: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let end = start + 1;
    while (end < characters.length && measure(characters.slice(start, end + 1).join('').trimEnd()) <= width) end += 1;
    while (end < characters.length && end - start > 1 && NO_START.has(characters[end] ?? '')) end -= 1;
    parts.push(characters.slice(start, end).join(''));
    start = end;
  }
  return parts;
}

/**
 * The lines `text` (one paragraph) is set in at `width`: as many pieces on a line as fit, a space at the end of a
 * line taking no room. Any run of white space counts as one space.
 */
export function wrap(text: string, width: number, measure: Measure): string[] {
  const lines: string[] = [];
  let line = '';
  for (const piece of piecesOf(text.replace(/\s+/g, ' ').trim())) {
    const longer = line + piece;
    if (!line || measure(longer.trimEnd()) <= width) {
      line = longer;
    } else {
      lines.push(line.trimEnd());
      line = piece;
    }
    if (measure(line.trimEnd()) > width) {
      const parts = cut(line, width, measure);
      lines.push(...parts.slice(0, -1).map((part) => part.trimEnd()));
      line = parts.at(-1) ?? '';
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

/** The paragraphs of a written text: its lines, without the empty ones and the spaces round each. */
export function paragraphsOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
