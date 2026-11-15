import { Box3, type Mesh, type Object3D } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// A guardian dog's model as frontend/scripts/guardians-normalize.mjs leaves it: one unit tall, standing on the origin
// and facing +z. Each is fetched once, and its mesh and picture are shared by every home that dog keeps.

export type DogModel = {
  /** The model's scene, cloned for each place the dog stands. */
  scene: Object3D;
  /** How far it reaches to either side of its middle, and behind it (a negative z), of its height. */
  halfWidth: number;
  back: number;
};

const models = new Map<string, Promise<DogModel>>();

export const dogModelUrl = (id: string) => `/gltf/guardians/${id}.glb`;

/** The model of dog `id`. A load that failed is tried again the next time it is asked for. */
export function loadDogModel(id: string): Promise<DogModel> {
  let model = models.get(id);
  if (!model) {
    model = new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .loadAsync(dogModelUrl(id))
      .then(({ scene }) => {
        scene.traverse((object) => {
          const mesh = object as Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        });
        // Measured through the scene: the file keeps its vertices packed, behind a transform that unpacks them.
        const box = new Box3().setFromObject(scene);
        return { scene, halfWidth: Math.max(-box.min.x, box.max.x), back: box.min.z };
      });
    models.set(id, model);
    model.catch(() => models.delete(id));
  }
  return model;
}
