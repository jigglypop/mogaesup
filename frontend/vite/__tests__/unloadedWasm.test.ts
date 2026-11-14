// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { unloadedWasm, unloadedWasmFiles } from '../unloadedWasm';

const bundle = () => ({
  'assets/SajuPage-abc.js': { type: 'chunk' as const, code: 'import"./vendor-def.js";' },
  'assets/vendor-def.js': { type: 'chunk' as const, code: 'new URL("physics-123.wasm",import.meta.url)' },
  'assets/physics-123.wasm': { type: 'asset' as const },
  'assets/jamiblossom_core_bg-456.wasm': { type: 'asset' as const },
  'assets/style-789.css': { type: 'asset' as const },
});

describe('불러오지 않는 WebAssembly', () => {
  it('어느 스크립트도 이름을 부르지 않는 .wasm만 고른다', () => {
    expect(unloadedWasmFiles(bundle())).toEqual(['assets/jamiblossom_core_bg-456.wasm']);
    expect(unloadedWasmFiles({ 'assets/a.wasm': { type: 'asset' } })).toEqual(['assets/a.wasm']);
    expect(unloadedWasmFiles({ 'assets/a.js': { type: 'chunk', code: 'fetch("/assets/a.wasm")' }, 'assets/a.wasm': { type: 'asset' } })).toEqual([]);
  });

  it('빌드에서 그 파일만 뺀다', () => {
    const emitted = bundle();
    const plugin = unloadedWasm();
    (plugin.generateBundle as (options: unknown, bundle: unknown) => void).call({}, {}, emitted);
    expect(Object.keys(emitted)).toEqual(['assets/SajuPage-abc.js', 'assets/vendor-def.js', 'assets/physics-123.wasm', 'assets/style-789.css']);
    expect(plugin.apply).toBe('build');
  });
});
