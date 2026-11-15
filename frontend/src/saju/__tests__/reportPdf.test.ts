import { describe, expect, it } from 'vitest';

import { A4, jpegOf, pdfDate, pdfOf, textString, type Jpeg } from '../report/pdf';

/**
 * The marker segments of a JPEG as far as its frame header, which is all the writer reads: a JFIF segment, a frame of
 * `width`×`height` with `components`, the start of a scan and its end. `fill` puts fill bytes before the frame's marker.
 */
function fakeJpeg(width: number, height: number, components = 3, { fill = 0, frame = 0xc0 } = {}): Uint8Array {
  const jfif = [0xff, 0xe0, 0x00, 0x10, ...[...'JFIF'].map((character) => character.charCodeAt(0)), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const channels = Array.from({ length: components }, (_, index) => [index + 1, 0x11, 0x00]).flat();
  const sof = [0xff, frame, 0x00, 8 + components * 3, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, components, ...channels];
  const scan = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0x56];
  return new Uint8Array([0xff, 0xd8, ...jfif, ...Array.from({ length: fill }, () => 0xff), ...sof, ...scan, 0xff, 0xd9]);
}

/** The file as the one-byte characters a PDF is read in. */
const latin1 = (bytes: Uint8Array) => Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

/** Object `id`'s text, from `id 0 obj` to its `endobj`. */
function objectAt(file: string, offset: number, id: number): string {
  expect(file.startsWith(`${id} 0 obj\n`, offset)).toBe(true);
  return file.slice(offset, file.indexOf('endobj\n', offset));
}

/** Reads the file the way a viewer starts to: the last `startxref`, the table there, and the trailer under it. */
function read(bytes: Uint8Array) {
  const file = latin1(bytes);
  const tail = /startxref\n(\d+)\n%%EOF\n$/.exec(file);
  expect(tail).not.toBeNull();
  const table = Number(tail?.[1]);
  expect(file.startsWith('xref\n', table)).toBe(true);
  const [, first, count] = /^xref\n(\d+) (\d+)\n/.exec(file.slice(table)) ?? [];
  expect(first).toBe('0');
  const size = Number(count);
  const entriesAt = table + `xref\n0 ${size}\n`.length;
  const entries = Array.from({ length: size }, (_, index) => file.slice(entriesAt + index * 20, entriesAt + (index + 1) * 20));
  const trailer = file.slice(entriesAt + size * 20, file.lastIndexOf('startxref'));
  const objects = new Map<number, string>();
  entries.forEach((entry, id) => {
    if (id === 0) return;
    expect(entry).toMatch(/^\d{10} 00000 n \n$/);
    objects.set(id, objectAt(file, Number(entry.slice(0, 10)), id));
  });
  return { file, size, entries, trailer, objects };
}

/** What an object's `/Name n 0 R` refers to. */
const ref = (text: string, name: string) => Number(new RegExp(`/${name} (\\d+) 0 R`).exec(text)?.[1]);
/** The bytes of an object's stream, cut exactly as its `/Length` says. */
function streamOf(bytes: Uint8Array, file: string, object: string): Uint8Array {
  const length = Number(/\/Length (\d+)/.exec(object)?.[1]);
  const start = file.indexOf(object) + object.indexOf('stream\n') + 'stream\n'.length;
  expect(file.slice(start + length, start + length + '\nendstream\n'.length)).toBe('\nendstream\n');
  return bytes.slice(start, start + length);
}
/** A text string written in hexadecimal UTF-16, as the document's title is. */
function decodeText(hex: string): string {
  const units = hex.match(/[0-9A-F]{4}/g) ?? [];
  expect(units[0]).toBe('FEFF');
  return String.fromCharCode(...units.slice(1).map((unit) => parseInt(unit, 16)));
}

describe('JPEG 머리 읽기', () => {
  it('프레임 머리에서 크기와 색 성분 수를 읽는다', () => {
    expect(jpegOf(fakeJpeg(1654, 2339))).toMatchObject({ width: 1654, height: 2339, components: 3 });
    expect(jpegOf(fakeJpeg(40, 30, 1))).toMatchObject({ width: 40, height: 30, components: 1 });
    // A progressive frame, and fill bytes before the marker.
    expect(jpegOf(fakeJpeg(800, 600, 3, { fill: 3, frame: 0xc2 }))).toMatchObject({ width: 800, height: 600 });
  });

  it('JPEG이 아니거나 PDF가 그대로 담을 수 없는 것은 받지 않는다', () => {
    expect(() => jpegOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow('not a JPEG');
    expect(() => jpegOf(fakeJpeg(10, 10, 4))).toThrow('4 components');
    expect(() => jpegOf(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]))).toThrow('without a frame header');
  });
});

describe('PDF 쓰기', () => {
  const pages: Jpeg[] = [jpegOf(fakeJpeg(1654, 2339)), jpegOf(fakeJpeg(1654, 2339)), jpegOf(fakeJpeg(800, 1131, 1))];
  const created = new Date(2026, 10, 15, 9, 30, 5);

  it('머리와 이진 표시, 객체마다 표가 가리키는 자리, 트레일러를 갖춘다', () => {
    const bytes = pdfOf(pages, { title: '노을 · 팔자피자', created });
    const { file, size, entries, trailer, objects } = read(bytes);
    expect(file.startsWith('%PDF-1.4\n%')).toBe(true);
    // The second line's bytes above 127 tell a program that the file is binary.
    expect([...bytes.slice(10, 14)].every((byte) => byte > 127)).toBe(true);
    // A catalog, a page tree and the info, then three objects for each page.
    expect(size).toBe(4 + pages.length * 3);
    expect(entries[0]).toBe('0000000000 65535 f \n');
    expect(objects.size).toBe(size - 1);
    expect(trailer).toContain(`/Size ${size}`);
    expect(ref(trailer, 'Root')).toBe(1);
    expect(ref(trailer, 'Info')).toBe(3);
    expect(trailer).toMatch(/\/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\]/);
    expect(objects.get(1)).toContain('/Type /Catalog');
    expect(ref(objects.get(1) ?? '', 'Pages')).toBe(2);
  });

  it('쪽 나무가 쪽 수만큼의 A4 쪽을 차례대로 담고, 쪽마다 JPEG 하나를 온 쪽에 그린다', () => {
    const bytes = pdfOf(pages, { title: '팔자피자', created });
    const { file, objects } = read(bytes);
    const tree = objects.get(2) ?? '';
    expect(tree).toContain('/Type /Pages');
    expect(tree).toContain(`/Count ${pages.length}`);
    const kids = [...(/\/Kids \[([^\]]*)\]/.exec(tree)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((match) => Number(match[1]));
    expect(kids).toHaveLength(pages.length);
    kids.forEach((id, index) => {
      const page = objects.get(id) ?? '';
      expect(page).toContain('/Type /Page ');
      expect(ref(page, 'Parent')).toBe(2);
      expect(page).toContain(`/MediaBox [0 0 ${A4.width} ${A4.height}]`);
      const contents = objects.get(ref(page, 'Contents')) ?? '';
      expect(latin1(streamOf(bytes, file, contents))).toBe(`q\n${A4.width} 0 0 ${A4.height} 0 0 cm\n/Im Do\nQ`);
      const image = objects.get(ref(page, 'Im')) ?? '';
      const jpeg = pages[index]!;
      expect(image).toContain('/Subtype /Image');
      expect(image).toContain(`/Width ${jpeg.width} /Height ${jpeg.height}`);
      expect(image).toContain(jpeg.components === 1 ? '/ColorSpace /DeviceGray' : '/ColorSpace /DeviceRGB');
      expect(image).toContain('/Filter /DCTDecode');
      expect(streamOf(bytes, file, image)).toEqual(jpeg.bytes);
    });
  });

  it('문서 정보에 한글 제목과 만든 때를 적는다', () => {
    const { objects } = read(pdfOf(pages.slice(0, 1), { title: '노을 · 팔자피자', created }));
    const info = objects.get(3) ?? '';
    expect(decodeText(/\/Title <([0-9A-F]+)>/.exec(info)?.[1] ?? '')).toBe('노을 · 팔자피자');
    expect(info).toContain(`/CreationDate (${pdfDate(created)})`);
  });

  it('쪽이 없으면 만들지 않는다', () => {
    expect(() => pdfOf([], { title: '팔자피자', created })).toThrow();
  });
});

describe('PDF의 글과 날짜', () => {
  it('글은 바이트 순서 표시 뒤 UTF-16BE 16진수로 쓴다', () => {
    expect(textString('가A')).toBe('<FEFFAC000041>');
    // A character beyond the first plane goes as its two surrogates.
    expect(textString('🍕')).toBe('<FEFFD83CDF55>');
  });

  it('날짜는 이 컴퓨터의 시각과 시간대로 쓴다', () => {
    const date = new Date(2026, 10, 5, 7, 8, 9);
    const written = pdfDate(date);
    expect(written).toMatch(/^D:20261105070809[+-]\d{2}'\d{2}'$/);
    const offset = -date.getTimezoneOffset();
    const [, sign, hours, minutes] = /([+-])(\d{2})'(\d{2})'$/.exec(written) ?? [];
    expect((sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes))).toBe(offset);
  });
});
