import type { Object3D, SkinnedMesh } from 'three';

/** Preserve authored glTF local transforms, including scaled armature parents.
 * Skeleton.pose() reconstructs world bind matrices and can lose that parent
 * space on provider rigs. Rest mode must restore the loaded asset, not rebind it.
 */
export function captureRestPose(root: Object3D): () => void {
  const nodes: { object: Object3D; position: Object3D['position']; quaternion: Object3D['quaternion']; scale: Object3D['scale'] }[] = [];
  root.traverse(object => nodes.push({ object, position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() }));
  return () => {
    for (const { object, position, quaternion, scale } of nodes) {
      object.position.copy(position); object.quaternion.copy(quaternion); object.scale.copy(scale); object.updateMatrix();
    }
    root.updateMatrixWorld(true);
    root.traverse(object => {
      const mesh = object as SkinnedMesh;
      if (mesh.isSkinnedMesh) {
        mesh.skeleton.update(); mesh.computeBoundingBox(); mesh.computeBoundingSphere();
      }
    });
  };
}
