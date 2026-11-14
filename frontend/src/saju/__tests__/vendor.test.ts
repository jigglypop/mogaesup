import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// 사주 is calculated by jamiblossom, kept in vendor/ as its own package packed it (its .md says from where and how to
// replace it). A registry version is for once the library is published, and this test changes with it.
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const library = resolve(dirname(fileURLToPath(import.meta.resolve('jamiblossom'))), '..');
const read = (path: string) => readFileSync(path, 'utf8');

describe('사주 라이브러리 jamiblossom', () => {
  const wanted: string = JSON.parse(read(resolve(frontend, 'package.json'))).dependencies['jamiblossom'];
  const [, tarball = '', version = ''] = /^file:(vendor\/jamiblossom-(.+)\.tgz)$/.exec(wanted) ?? [];

  it('package.json이 vendor/의 묶음을 가리키고, 설치된 라이브러리가 그 버전이다', () => {
    expect(version, `jamiblossom: ${wanted}`).not.toBe('');
    expect(existsSync(resolve(frontend, tarball))).toBe(true);
    expect(JSON.parse(read(resolve(library, 'package.json'))).version).toBe(version);
  });

  it('묶음이 설명서에 적힌 그 파일이다', () => {
    const digest = createHash('sha256').update(readFileSync(resolve(frontend, tarball))).digest('hex');
    expect(read(resolve(frontend, tarball.replace(/\.tgz$/, '.md')))).toContain(digest);
  });

  it('마을이 쓰는 계산과 달력 함수를 내보낸다', () => {
    const exported = read(resolve(library, 'dist/index.d.ts'));
    for (const module of ['calculate', 'sinsal', 'korean-calendar', 'time', 'types']) expect(exported).toContain(`./${module}.js`);
    expect(read(resolve(library, 'dist/calculate.d.ts'))).toContain('calculateZiweiChart');
    expect(read(resolve(library, 'dist/types.d.ts'))).toContain('sinsal: SinsalResult');
  });
});
