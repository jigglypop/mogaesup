import { createReadStream, existsSync, statSync } from 'node:fs';
import { cp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
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
 * The package's own figures (`gltf/*.glb`) were the 미니미 before the studio made them. Only the fallback that islands
 * walk as before they pick one (`FALLBACK_MINIME` in src/minihome/figures.ts) is served and shipped; props, nature and
 * the rest of `gltf/` below it are.
 */
const FIGURES_KEPT = new Set(['man.glb']);
/** A GLB directly in `gltf/` (not in `props/`, `nature/` or another folder) other than the kept fallback. */
const isDroppedFigure = (path: string) =>
  path.endsWith('.glb') && !path.includes('/') && !path.includes('\\') && !FIGURES_KEPT.has(path);

/**
 * Texture sizes for the figures (`gltf/*.glb`: the fallback 미니미 the package ships). The minihome
 * camera sits about 15 m from the player, so a 1.7 m figure spans roughly 90 px: colour maps past 1024 px and the other
 * maps past 512 px cost download and GPU memory without showing. The package keeps its full-size originals for closer
 * cameras.
 */
const FIGURE_MAPS = [
  { slots: /^(baseColor|emissive)/, resize: [1024, 1024] as [number, number], quality: 88 },
  { slots: /^(normal|metallicRoughness|occlusion)/, resize: [512, 512] as [number, number], quality: 90 },
];

/** Where the installed gaesup-world keeps its shipped models (`public/gltf`) and core WASM (`dist/wasm`). */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.resolve('gaesup-world'))), '..');
}

async function createIO(): Promise<NodeIO> {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

/** Rewrites each figure in `dir` with its maps sized for the minihome, as WebP, keeping Meshopt geometry. */
async function slimFigures(io: NodeIO, dir: string, log: (message: string) => void) {
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
 * Packs every model under `dir` that is not Meshopt-compressed yet (the package's props and nature carry plain float
 * buffers, and CloudFront does not compress models) with EXT_meshopt_compression, which the engine's loader decodes.
 * The codec is lossless: the same vertices and triangles come back, only each triangle's corners may start elsewhere
 * (same winding). A default island's props and plants shrink by about a third. A model packing does not shrink stays.
 */
async function packModels(io: NodeIO, dir: string, log: (message: string) => void) {
  let before = 0;
  let after = 0;
  let packed = 0;
  const files = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith('.glb'));
  for (const name of files) {
    const file = join(dir, name);
    const original = await readFile(file);
    const document = await io.readBinary(original);
    const used = document.getRoot().listExtensionsUsed();
    if (used.some((extension) => extension.extensionName === EXTMeshoptCompression.EXTENSION_NAME)) continue;
    document
      .createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    const smaller = await io.writeBinary(document);
    before += original.length;
    if (smaller.byteLength < original.length) {
      await writeFile(file, smaller);
      after += smaller.byteLength;
      packed += 1;
    } else after += original.length;
  }
  log(`models: ${packed} packed with Meshopt, ${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB`);
}

/**
 * Serves and ships the files gaesup-world's npm package carries: `/gltf/*` (characters, avatars, props and nature)
 * and `/wasm/*`. A file of the same path in this app's `public/` wins. Builds size the figures' textures for the
 * minihome camera and pack the other models with Meshopt; the dev server serves the package's files as they are.
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
        // The app's own public/ file of the same path wins, as it does in builds: Vite serves it after this.
        if (!mount || existsSync(join(config.publicDir, pathname))) return next();
        const inside = pathname.slice(mount.url.length);
        if (mount.url === '/gltf/' && isDroppedFigure(inside)) return next();
        const file = normalize(join(mount.dir, inside));
        if (!file.startsWith(mount.dir + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        response.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(response);
      });
    },
    async closeBundle() {
      if (config.command !== 'build') return;
      const outDir = resolve(config.root, config.build.outDir);
      for (const mount of mounts) {
        if (!existsSync(mount.dir)) continue;
        const filter = (source: string) => mount.url !== '/gltf/' || !isDroppedFigure(relative(mount.dir, source));
        await cp(mount.dir, join(outDir, mount.url), { recursive: true, force: false, filter });
      }
      const io = await createIO();
      const log = (message: string) => config.logger.info(message);
      await slimFigures(io, join(outDir, 'gltf'), log);
      await packModels(io, join(outDir, 'gltf'), log);
    },
  };
}
