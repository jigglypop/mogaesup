import { Mesh, SkinnedMesh, Texture, type Object3D, type Skeleton, type Material, type BufferGeometry } from 'three';

/** Release one owned asset, including shared images and skeletons, exactly once. */
export function disposeObjectResources(roots: readonly Object3D[], extraSkeletons: Iterable<Skeleton> = []) {
  const geometries = new Set<BufferGeometry>(), materials = new Set<Material>();
  const textures = new Set<Texture>(), skeletons = new Set(extraSkeletons);
  for (const root of roots) root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    if (object instanceof SkinnedMesh) skeletons.add(object.skeleton);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
  });
  const images = new Set(Array.from(textures, texture => texture.source.data));
  images.forEach(image => (image as ImageBitmap | undefined)?.close?.());
  for (const resource of [...textures, ...materials, ...geometries, ...skeletons]) resource.dispose();
}
