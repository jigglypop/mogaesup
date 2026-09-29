import { createReadStream, existsSync, statSync } from 'node:fs';
import { cp, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import type { Plugin, ResolvedConfig } from 'vite';

const CONTENT_TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

/**
 * Texture sizes for the figures (`gltf/*.glb`: the 미니미 and the island's residents). The minihome camera sits about
 * 15 m from the player, so a 1.7 m figure spans roughly 90 px: colour maps past 1024 px and the other maps past
 * 512 px cost download and GPU memory without showing. The package keeps its full-size originals for closer cameras.
 */
const FIGURE_MAPS = [
  { slots: /^(baseColor|emissive)/, resize: [1024, 1024] as [number, number], quality: 88 },
  { slots: /^(normal|metallicRoughness|occlusion)/, resize: [512, 512] as [number, number], quality: 90 },
];

/** Where the installed gaesup-world keeps its shipped models (`public/gltf`) and core WASM (`dist/wasm`). */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.resolve('gaesup-world'))), '..');
}

/** Rewrites each figure in `dir` with its maps sized for the minihome, as WebP, keeping Meshopt geometry. */
async function slimFigures(dir: string, log: (message: string) => void) {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  let before = 0;
  let after = 0;
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.glb'))) {
    const file = join(dir, name);
    before += (await stat(file)).size;
    const document = await io.read(file);
    await document.transform(
      ...FIGURE_MAPS.map(({ slots, resize, quality }) =>
        textureCompress({ encoder: sharp, targetFormat: 'webp', slots, resize, quality }),
      ),
    );
    await io.write(file, document);
    after += (await stat(file)).size;
  }
  log(`figures: ${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB`);
}

/**
 * Serves and ships the files gaesup-world's npm package carries: `/gltf/*` (characters, avatars, props and nature)
 * and `/wasm/*`. A file of the same path in this app's `public/` wins. Builds size the figures' textures for the
 * minihome camera; the dev server serves the package's files as they are.
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
      await slimFigures(join(outDir, 'gltf'), (message) => config.logger.info(message));
    },
  };
}
