// @vitest-environment node
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { isStudioFile, studioScope } from '../studio';

const sheet = fileURLToPath(new URL('../../src/character/studio/wardrobe.css', import.meta.url));
/** Every letter's case turned over, the drive letter's too. */
const flipped = (path: string) => [...path].map((letter) => (letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase())).join('');

describe('스튜디오 스타일 범위', () => {
  it('스튜디오 소스의 스타일만 .studio-root 안에 가둔다', async () => {
    const scoped = await postcss([studioScope()]).process(':root{--a:1} button{color:red}', { from: sheet });
    expect(scoped.css).toBe('.studio-root{--a:1} .studio-root button{color:red}');
    const app = fileURLToPath(new URL('../../src/ui/ui.css', import.meta.url));
    expect((await postcss([studioScope()]).process('button{color:red}', { from: app })).css).toBe('button{color:red}');
  });

  it('Windows에서는 드라이브 문자와 경로의 대소문자, 구분자가 달라도 같은 파일로 본다', () => {
    expect(isStudioFile(sheet)).toBe(true);
    expect(isStudioFile(flipped(sheet), 'win32')).toBe(true);
    expect(isStudioFile(flipped(sheet).replace(/\\/g, '/'), 'win32')).toBe(true);
    expect(isStudioFile(flipped(sheet), 'linux')).toBe(false);
  });

  it('이름이 비슷한 옆 폴더는 스튜디오가 아니다', () => {
    expect(isStudioFile(sheet.replace(/character([\\/])/, 'character-x$1'))).toBe(false);
    expect(isStudioFile(sheet.replace(/character([\\/])/, 'character-x$1'), 'win32')).toBe(false);
  });
});
