import type { Object3D } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const models = new Map<string, Promise<Object3D>>();
/** The village's own decorations: a few models every 섬 shares, kept for as long as the page is open. */
const SHARED = '/gltf/decor/';
/**
 * How many other models are kept: a member's character, one to a 섬 and each its own, the ones used longest ago let go
 * first (with their meshes and pictures, once nothing on the page shows them).
 */
const KEEP_OTHERS = 4;

/** Shared source. Each placed item clones it before changing its transform or materials. */
export function loadDecorModel(url: string): Promise<Object3D> {
  const known = models.get(url);
  if (known) {
    // Used again: kept the longest.
    models.delete(url);
    models.set(url, known);
    return known;
  }
  const model = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url).then((gltf) => gltf.scene);
  models.set(url, model);
  model.catch(() => {
    if (models.get(url) === model) models.delete(url);
  });
  const others = [...models.keys()].filter((key) => !key.startsWith(SHARED));
  for (const key of others.slice(0, Math.max(0, others.length - KEEP_OTHERS))) models.delete(key);
  return model;
}
