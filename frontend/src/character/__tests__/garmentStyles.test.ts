import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import garmentStyles from '../studio/garment-styles.json';

// A style's 3D reference ships from public/ as it is (the build slims only the package's models under gltf/), and the
// studio viewer refuses a file whose SHA-256 is not the one pinned in the catalog. Its card is a few hundred pixels
// tall, so maps past 1024 px only cost the download.
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public');
const MAX_BYTES = 2 * 1024 * 1024;
/**
 * Extensions the studio viewer's GLTFLoader is given no decoder for: a file using one fails to load (Draco always, the
 * others when required) or carries data the viewer never reads.
 */
const NEEDS_DECODER = ['KHR_draco_mesh_compression', 'KHR_texture_basisu', 'EXT_meshopt_compression', 'KHR_meshopt_compression'];
const models = (garmentStyles.garments as { name: string; model?: { url: string; sha256: string } }[])
  .flatMap(item => item.model ? [{ name: item.name, ...item.model }] : []);

describe('의상 스타일의 3D 참조', () => {
  it.each(models)('$name: 고정한 SHA-256 그대로이고, 작고, 스튜디오 뷰어가 읽는다', ({ url, sha256 }) => {
    const bytes = readFileSync(resolve(publicDir, url.replace(/^\//, '')));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    expect(bytes.length).toBeLessThanOrEqual(MAX_BYTES);
    // The JSON chunk follows the 12-byte file header and its own 8-byte header.
    const json = bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8');
    const gltf = JSON.parse(json) as { extensionsUsed?: string[]; extensionsRequired?: string[] };
    const extensions = [...(gltf.extensionsUsed ?? []), ...(gltf.extensionsRequired ?? [])];
    expect(extensions.filter(name => NEEDS_DECODER.includes(name))).toEqual([]);
  });
});
