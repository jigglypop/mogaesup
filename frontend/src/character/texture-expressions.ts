import * as THREE from 'three';
import { texture, uniform } from 'three/tsl';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { matteMaterial } from './matte-materials';

export const expressionNames = { neutral: '기본', smile: '웃음', cry: '울음', angry: '화남', surprise: '놀람', blink: '눈 감기' };
export type ExpressionName = keyof typeof expressionNames;
export type FaceLayout = { eye: number; mouth: number; spacing: number; size: number };
type Surface = { index: number; texture: THREE.Texture; original: THREE.TextureSource<unknown> };
type Entry = { surface: Surface; source: THREE.Source<ImageBitmap>; image: ImageBitmap };
type SavedMap = { material: number; url: string; sha256: string };

export function prepareExpressionMaterial(material: THREE.MeshStandardMaterial) {
  if (!material.map || material.userData.factory_expression_uv !== 'expression-base-color-uv-v1') return;
  Object.assign(material, { colorNode: texture(material.map).rgb.mul(uniform(material.color)) });
  const originalProgramKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${originalProgramKey()}:expression:${material.uuid}`;
  matteMaterial(material);
}

/** Use the server's rest-pose UV atlases unchanged in the studio and the world. */
export class TextureExpressions {
  private surfaces = new Map<THREE.Material, Surface>();
  private cache = new Map<string, Entry[]>();
  private sequence = 0;
  private disposed = false;
  constructor(gltf: GLTF) {
    gltf.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!(material instanceof THREE.MeshStandardMaterial) || !material.map || this.surfaces.has(material)) continue;
        // Covered and visible skin primitives may share the same glTF texture,
        // but their baked facial pixels differ. Give each material its own slot.
        material.map = material.map.clone();
        prepareExpressionMaterial(material);
        const index = gltf.parser.associations.get(material)?.materials;
        if (index !== undefined) this.surfaces.set(material, { index, texture: material.map, original: material.map.source });
      }
    });
    if (!this.surfaces.size) throw new Error('몸의 UV 텍스처를 찾을 수 없습니다.');
  }
  private restore() {
    this.surfaces.forEach(surface => this.update(surface, surface.original));
  }
  private update(surface: Surface, source: THREE.TextureSource<unknown>) {
    // WebGPU material nodes retain the texture used when the graph is built.
    // Keep that texture (and its UV channel/transform) and replace its pixels.
    surface.texture.source = source;
    surface.texture.needsUpdate = true;
  }
  private release(entries: Entry[]) {
    new Set(entries.map(entry => entry.image)).forEach(image => image.close());
  }
  clear() { this.sequence++; this.restore(); }
  dispose() {
    this.disposed = true; this.clear();
    this.cache.forEach(entries => this.release(entries)); this.cache.clear();
  }
  async saved(maps: SavedMap[]) {
    if (this.disposed) return false;
    const sequence = ++this.sequence;
    const surfaces = [...this.surfaces.values()];
    if (!maps.length || new Set(maps.map(map => map.material)).size !== maps.length
      || maps.some(map => !surfaces.some(surface => surface.index === map.material))) throw new Error('현재 몸에 맞는 표정 텍스처가 아닙니다.');
    const key = maps.map(map => `${map.material}:${map.sha256}`).sort().join('|');
    let entries = this.cache.get(key);
    if (!entries) {
      const loaded = await Promise.allSettled(maps.map(async map => ({ ...map, image: await loadImage(map.url, map.sha256) })));
      const failure = loaded.find(result => result.status === 'rejected');
      if (this.disposed || sequence !== this.sequence || failure) {
        loaded.forEach(result => { if (result.status === 'fulfilled') result.value.image.close(); });
        if (failure?.status === 'rejected') throw failure.reason;
        return false;
      }
      entries = loaded.flatMap(result => {
        if (result.status !== 'fulfilled') return [];
        const { image, material } = result.value;
        const source = new THREE.Source(image);
        return surfaces.filter(surface => surface.index === material).map(surface => ({ surface, source, image }));
      });
    }
    this.restore();
    this.cache.delete(key); this.cache.set(key, entries);
    entries.forEach(({ surface, source }) => this.update(surface, source));
    while (this.cache.size > 3) {
      const first = this.cache.keys().next().value!;
      this.release(this.cache.get(first)!); this.cache.delete(first);
    }
    return true;
  }
}

async function loadImage(url: string, expected: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('표정 텍스처를 불러올 수 없습니다.');
  const bytes = await response.arrayBuffer();
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
  if (sha !== expected) throw new Error('표정 텍스처가 변경되었습니다.');
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}
