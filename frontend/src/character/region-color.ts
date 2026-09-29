import { Color, MeshStandardMaterial, type Texture } from 'three';
import { float, max, mix, texture, uniform, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';

/** Recolour up to four texture regions (one mask channel each; the fourth is stored inverted in alpha)
 * while keeping each texel's shading.
 * lights: mean linear luminance of each region, so a texel keeps its brightness relative to its region. */
export function regionColorControl(material: MeshStandardMaterial, mask: Texture, lights: number[]) {
  const sampled = material.map ? texture(material.map) : null;
  // A colour uniform is a vec3 in the shader; the typings keep it apart.
  const tint = uniform(material.color.clone()) as unknown as Node<'vec3'>;
  const base = sampled ? sampled.rgb.mul(tint) : tint;
  const regions = texture(mask);
  const luminance = base.dot(vec3(.2126, .7152, .0722));
  const targets = [0, 1, 2, 3].map(() => uniform(new Color('#ffffff')));
  const amounts = [0, 1, 2, 3].map(() => uniform(0));
  const weights = [regions.r, regions.g, regions.b, float(1).sub(regions.a)];
  const color = weights.reduce((current, weight, index) => {
    const target = targets[index], amount = amounts[index];
    if (!target || !amount) return current;
    const shaded = target.mul(luminance.div(max(float(lights[index] ?? .5), .02))).clamp(0, 1);
    return mix(current, shaded, weight.mul(amount));
  }, base as unknown as ReturnType<typeof mix>);
  Object.assign(material, { colorNode: sampled ? vec4(color, sampled.a) : color });
  material.needsUpdate = true;
  return (colors: (string | null)[]) => {
    amounts.forEach((amount, index) => {
      const value = colors[index];
      amount.value = value ? 1 : 0;
      if (value) targets[index]?.value.set(value);
    });
  };
}
