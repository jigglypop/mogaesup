import type { Material } from 'three';

/** Each material's own cache key, as it was before a control changed it. */
const originalKeys = new WeakMap<Material, () => string>();
let assigned = 0;

/**
 * Gives `material` a shader program key of its own.
 *
 * WebGPU builds one program, with its bindings, per material cache key. A plain material's key only tells that it has
 * a `colorNode`, not what that node holds, so two garments with the same flags (a hoodie and sneakers, a hair and
 * another hair) would draw with whichever was built first: its texture and its colours. Controls that set a node on a
 * plain material call this, after it, so every material keeps its own textures and colours. Calling it again for the
 * same material (its node was rebuilt) replaces the key.
 */
export function ownProgramKey(material: Material, tag: string): void {
  const original = originalKeys.get(material) ?? material.customProgramCacheKey.bind(material);
  originalKeys.set(material, original);
  const own = `${tag}:${material.uuid}:${++assigned}`;
  material.customProgramCacheKey = () => `${original()}:${own}`;
}
