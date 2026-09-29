import { DoubleSide, MeshPhysicalMaterial, MeshStandardMaterial, type Material, type Mesh, type Object3D } from 'three';

/** One soft matte finish for every character surface: no metal, no glow, near-full roughness,
 * softened provider normal maps and both faces drawn (a sleeve, collar or hem shows its inside, and a
 * provider's reversed triangle is not a hole). The assembly export writes the same values
 * (avatar_blender_common.py). */
export const MATTE_ROUGHNESS = .95;
export const MATTE_NORMAL_SCALE = .4;
/** Equipment keeps its own finish (a blade may be metal). */
const OWN_FINISH = new Set(['weapon', 'tool', 'glasses']);

export function matteMaterial(material: Material) {
  if (!(material instanceof MeshStandardMaterial)) return;
  material.side = DoubleSide;
  material.metalness = 0; material.metalnessMap = null;
  material.roughness = MATTE_ROUGHNESS; material.roughnessMap = null;
  material.emissive.set(0); material.emissiveMap = null;
  if (material.normalMap) material.normalScale.set(MATTE_NORMAL_SCALE, MATTE_NORMAL_SCALE);
  if (material instanceof MeshPhysicalMaterial) {
    material.specularIntensity = 1; material.specularIntensityMap = null;
    material.specularColor.set(1, 1, 1); material.specularColorMap = null; material.ior = 1.5;
  }
  material.needsUpdate = true;
}

export function matteCharacter(root: Object3D) {
  root.traverse(object => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    for (let node: Object3D | null = mesh; node; node = node.parent) {
      if (OWN_FINISH.has(String(node.userData.standard_slot))) return;
    }
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(matteMaterial);
  });
}
