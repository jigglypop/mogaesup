import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The app runs a patched gaesup-world kept in vendor/ (its .md lists the changes and how to rebuild it), not the npm
// release: remote avatars keep their authored colours, and updates carry the visible rotation and the sender's sample
// time. A registry version is for once upstream releases those changes, and this test changes with it.
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engine = resolve(dirname(fileURLToPath(import.meta.resolve('gaesup-world'))), '..');
const read = (path: string) => readFileSync(path, 'utf8');

describe('엔진 gaesup-world', () => {
  it('package.json이 vendor/의 패치 빌드를 가리키고, 설치된 엔진이 그 버전이다', () => {
    const wanted: string = JSON.parse(read(resolve(frontend, 'package.json'))).dependencies['gaesup-world'];
    const [, tarball = '', version] = /^file:(vendor\/gaesup-world-(.+-mogaesup\.\d+)\.tgz)$/.exec(wanted) ?? [];
    expect(version, `gaesup-world: ${wanted}`).toBeDefined();
    expect(existsSync(resolve(frontend, tarball))).toBe(true);
    expect(JSON.parse(read(resolve(engine, 'package.json'))).version).toBe(version);
  });

  it('설치된 엔진에 패치가 더한 옵션이 있다', () => {
    expect(read(resolve(engine, 'dist/core/networks/hooks/useMultiplayer.d.ts'))).toContain('visualRotationRef');
    const config = read(resolve(engine, 'dist/core/networks/types/index.d.ts'));
    expect(config).toContain('tintCharacter');
    expect(config).toContain('materialPolicy');
  });
});
