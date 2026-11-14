import type { Plugin } from 'vite';

type Emitted = { type: 'chunk'; code: string } | { type: 'asset' };

/** The `.wasm` files of a build that none of its scripts names: a script loads an asset by its file's name. */
export function unloadedWasmFiles(bundle: Record<string, Emitted>): string[] {
  const codes = Object.values(bundle).flatMap((file) => (file.type === 'chunk' ? [file.code] : []));
  return Object.entries(bundle)
    .filter(([fileName, file]) => {
      if (file.type !== 'asset' || !fileName.endsWith('.wasm')) return false;
      const name = fileName.slice(fileName.lastIndexOf('/') + 1);
      return !codes.some((code) => code.includes(name));
    })
    .map(([fileName]) => fileName);
}

/**
 * Leaves out of the build a WebAssembly file no script of the build loads. jamiblossom's index re-exports its WASM
 * loader; the 사주 village calculates in JavaScript (src/saju/engine.ts), so the loader is shaken out of the scripts,
 * but the bundler has by then emitted the `.wasm` it names.
 */
export function unloadedWasm(): Plugin {
  return {
    name: 'mogaesup:unloaded-wasm',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const fileName of unloadedWasmFiles(bundle)) delete bundle[fileName];
    },
  };
}
