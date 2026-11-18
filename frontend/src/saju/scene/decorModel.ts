import type { Object3D } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const models = new Map<string, Promise<Object3D>>();

/** Shared source. Each placed item clones it before changing its transform or materials. */
export function loadDecorModel(url: string): Promise<Object3D> {
  let model = models.get(url);
  if (!model) {
    model = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url).then((gltf) => gltf.scene);
    models.set(url, model);
    model.catch(() => models.delete(url));
  }
  return model;
}
