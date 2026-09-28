import { createReadStream, existsSync, statSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Plugin, ResolvedConfig } from 'vite';

const CONTENT_TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

/** Where the installed gaesup-world keeps its shipped models (`public/gltf`) and core WASM (`dist/wasm`). */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.resolve('gaesup-world'))), '..');
}

/**
 * Serves and ships the files gaesup-world's npm package carries: `/gltf/*` (characters, avatars, props and nature)
 * and `/wasm/*`. A file of the same path in this app's `public/` wins.
 */
export function gaesupAssets(): Plugin {
  const root = packageRoot();
  const mounts = [
    { url: '/gltf/', dir: join(root, 'public', 'gltf') },
    { url: '/wasm/', dir: join(root, 'dist', 'wasm') },
  ];
  let config: ResolvedConfig;
  return {
    name: 'mogaesup:gaesup-assets',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = decodeURIComponent((request.url ?? '').split('?')[0] ?? '');
        const mount = mounts.find((item) => pathname.startsWith(item.url));
        if (!mount) return next();
        const file = normalize(join(mount.dir, pathname.slice(mount.url.length)));
        if (!file.startsWith(mount.dir + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        response.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(response);
      });
    },
    async closeBundle() {
      if (config.command !== 'build') return;
      const outDir = resolve(config.root, config.build.outDir);
      for (const mount of mounts) {
        if (existsSync(mount.dir)) await cp(mount.dir, join(outDir, mount.url), { recursive: true, force: false });
      }
    },
  };
}
