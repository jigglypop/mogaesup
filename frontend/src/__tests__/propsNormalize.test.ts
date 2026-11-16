// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Document, getBounds, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/props-normalize.mjs', import.meta.url));
const packageGltf = resolve(dirname(fileURLToPath(import.meta.resolve('gaesup-world'))), '../public/gltf');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
let work = '';

/** What scripts/props/generate.py leaves for `id`: a 0.6 × 1 × 0.4 m model off the origin, and the picture it came from. */
async function generate(id: string) {
  const document = new Document();
  const buffer = document.createBuffer();
  const corners = [-0.3, 0.3].flatMap((x) => [-0.5, 0.5].flatMap((y) => [0.1, 0.5].flatMap((z) => [x, y, z])));
  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', document.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(corners)))
    .setIndices(document.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Uint16Array([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7])))
    .setMaterial(document.createMaterial().setMetallicFactor(1));
  document.createScene().addChild(document.createNode().setMesh(document.createMesh().addPrimitive(primitive)));
  const folder = join(work, 'out', id);
  mkdirSync(folder, { recursive: true });
  await io.write(join(folder, 'model.glb'), document);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: { create: { width: 30, height: 40, channels: 3, background: { r: 200, g: 50, b: 50 } } }, left: 17, top: 12 }])
    .png()
    .toFile(join(folder, 'image.png'));
}

/** Runs the script on the generated items into a folder of its own: how it ended, and every file it wrote. */
function normalize(...args: string[]) {
  const output = mkdtempSync(join(work, 'public-'));
  const run = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, PROPS_SOURCE: join(work, 'out'), PROPS_OUTPUT: output },
    encoding: 'utf8',
  });
  const files = readdirSync(output, { recursive: true, encoding: 'utf8' })
    .filter((path) => statSync(join(output, path)).isFile())
    .map((path) => path.split(sep).join('/'))
    .sort();
  return { status: run.status, stderr: run.stderr, output, files };
}

async function boxOf(path: string) {
  const document = await io.read(path);
  const { min, max } = getBounds(document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0]!);
  return { min, max, size: max.map((value, axis) => value - min[axis]!) };
}

beforeAll(async () => {
  await MeshoptDecoder.ready;
  work = mkdtempSync(join(tmpdir(), 'props-normalize-'));
  // mailbox-basic was made to replace the package's mailbox and has a `fit`; rock-pile-small is decor the package lacks.
  await Promise.all(['mailbox-basic', 'rock-pile-small'].map(generate));
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('기물 정규화 스크립트', { timeout: 60_000 }, () => {
  it('기본 실행은 카탈로그 가구와 서랍 그림만 쓰고 엔진 모델 자리는 건드리지 않는다', async () => {
    const run = normalize();
    expect(run.status, run.stderr).toBe(0);
    expect(run.files).toEqual([
      'decor/mailbox-basic.glb',
      'decor/rock-pile-small.glb',
      'decor/thumbs/mailbox-basic.webp',
      'decor/thumbs/rock-pile-small.webp',
    ]);
    // Catalog furniture is placed at scale 1, so `fit` is its height on the island.
    expect((await boxOf(join(run.output, 'decor/mailbox-basic.glb'))).size[1]).toBeCloseTo(1.15, 3);
  });

  it('--replace는 바꿀 id를 받지 않으면 아무것도 쓰지 않는다', () => {
    const run = normalize('--replace');
    expect(run.status).not.toBe(0);
    expect(run.files).toEqual([]);
  });

  it('--replace는 manifest의 fit 대신 바꾸는 엔진 모델의 상자와 피벗에 맞춘다', async () => {
    const run = normalize('--replace', 'mailbox-basic');
    expect(run.status, run.stderr).toBe(0);
    expect(run.files).toEqual(['props/mailbox.glb']);
    const engine = await boxOf(join(packageGltf, 'props/mailbox.glb'));
    const written = await boxOf(join(run.output, 'props/mailbox.glb'));
    // Inside the package model's box and filling it on the tightest axis, on its floor, centred where it is centred: the
    // engine catalog's defaultScale then places it at the old size.
    for (const axis of [0, 1, 2]) expect(written.size[axis]).toBeLessThanOrEqual(engine.size[axis]! + 1e-4);
    expect(Math.max(...[0, 1, 2].map((axis) => written.size[axis]! / engine.size[axis]!))).toBeCloseTo(1, 3);
    expect(written.min[1]).toBeCloseTo(engine.min[1], 3);
    for (const axis of [0, 2]) expect(written.min[axis]! + written.max[axis]!).toBeCloseTo(engine.min[axis]! + engine.max[axis]!, 3);
  });
});
