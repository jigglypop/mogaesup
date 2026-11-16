// A PDF of pictures: every page is one JPEG drawn across an A4 sheet. Nothing else goes in (no fonts, no text
// layer), which is why a writer this small is enough: a catalog, a page tree, the document's info, three objects a
// page, and the table of where each object starts.

/** A4 portrait, in the points (1/72 inch) a PDF measures pages in. */
export const A4 = { width: 595.28, height: 841.89 } as const;

/** A JPEG as a page carries it: its bytes, its size in pixels and its colour components (grey, or RGB). */
export type Jpeg = { bytes: Uint8Array; width: number; height: number; components: 1 | 3 };

export type PdfInfo = {
  /** What a viewer shows as the document's name. */
  title: string;
  created: Date;
};

/**
 * Reads a JPEG's frame header for its size and components.
 * @throws when `bytes` is not a JPEG of one or three components
 */
export function jpegOf(bytes: Uint8Array): Jpeg {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');
  const word = (at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) throw new Error('broken JPEG');
    const marker = bytes[at + 1] ?? 0;
    // A marker may be padded with fill bytes; the restart markers and TEM stand alone, without a length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // Every start-of-frame (C0–CF) but the Huffman (C4) and arithmetic (CC) tables and the reserved C8.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const components = bytes[at + 9];
      if (components !== 1 && components !== 3) throw new Error(`a JPEG of ${components ?? 0} components`);
      return { bytes, width: word(at + 7), height: word(at + 5), components };
    }
    if (marker === 0xda || marker === 0xd9) break;
    at += 2 + word(at + 2);
  }
  throw new Error('a JPEG without a frame header');
}

/** A PDF text string in UTF-16BE behind its byte order mark, written in hex: any script can be put in one. */
export function textString(text: string): string {
  let hex = 'FEFF';
  for (let index = 0; index < text.length; index += 1) hex += text.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

const two = (value: number) => String(value).padStart(2, '0');

/** `D:20261115093000+09'00'`: a date as the info dictionary writes one, in the machine's time zone. */
export function pdfDate(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? '-' : '+'}${two(Math.floor(Math.abs(offset) / 60))}'${two(Math.abs(offset) % 60)}'`;
  return `D:${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}${zone}`;
}

/** The bytes of the file's own words, which are ASCII but for the header's marks of a binary file. */
function bytesOf(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

const number = (value: number) => String(Math.round(value * 100) / 100);

/**
 * A PDF of `pages` in order, each drawn over a whole A4 sheet. Objects: 1 the catalog, 2 the page tree, 3 the info,
 * then for each page its page, its contents and its image.
 */
export function pdfOf(pages: readonly Jpeg[], info: PdfInfo): Uint8Array<ArrayBuffer> {
  if (pages.length === 0) throw new Error('a PDF needs a page');
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const put = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? bytesOf(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, dictionary: string, stream?: Uint8Array) => {
    offsets[id] = length;
    put(`${id} 0 obj\n${dictionary}\n`);
    if (stream) {
      put('stream\n');
      put(stream);
      put('\nendstream\n');
    }
    put('endobj\n');
  };
  const pageId = (index: number) => 4 + index * 3;

  // The second line's marks above 127 tell a program that moves files about that this one is binary.
  put('%PDF-1.4\n%âãÏÓ\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R /Lang (ko-KR) /ViewerPreferences << /DisplayDocTitle true >> >>');
  object(2, `<< /Type /Pages /Kids [${pages.map((_, index) => `${pageId(index)} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  object(3, `<< /Title ${textString(info.title)} /CreationDate (${pdfDate(info.created)}) >>`);
  const box = `${number(A4.width)} ${number(A4.height)}`;
  pages.forEach((page, index) => {
    const id = pageId(index);
    const contents = bytesOf(`q\n${number(A4.width)} 0 0 ${number(A4.height)} 0 0 cm\n/Im Do\nQ`);
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${box}] /Resources << /XObject << /Im ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    object(id + 1, `<< /Length ${contents.length} >>`, contents);
    object(
      id + 2,
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /${page.components === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>`,
      page.bytes,
    );
  });

  const size = pageId(pages.length);
  const table = length;
  // Every entry is twenty bytes, its line ending included.
  put(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let id = 1; id < size; id += 1) put(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  const mark = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  put(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R /ID [<${mark}> <${mark}>] >>\nstartxref\n${table}\n%%EOF\n`);

  const file = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    file.set(chunk, at);
    at += chunk.length;
  }
  return file;
}
