import { Color, MeshStandardMaterial } from 'three';
import { mix, texture, uniform, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';

/** Recolor in linear light while retaining the texture's strand luminance and PBR maps. */
export function hairColorControl(material: MeshStandardMaterial) {
  const target = uniform(new Color('#8a7998')), amount = uniform(0);
  const sampled = material.map ? texture(material.map) : null;
  // A colour uniform is a vec3 in the shader; the typings keep it apart.
  const tint = uniform(material.color.clone()) as unknown as Node<'vec3'>;
  const original = sampled ? sampled.rgb.mul(tint) : tint;
  const luminance = original.dot(vec3(.2126, .7152, .0722));
  const recolored = mix(original, target.mul(luminance.mul(2.5)).clamp(0, 1), amount);
  Object.assign(material, { colorNode: sampled ? vec4(recolored, sampled.a) : recolored });
  const oldCompile = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    oldCompile(shader, renderer);
    shader.uniforms.hairTarget = { value: target.value };
    shader.uniforms.hairAmount = amount;
    shader.fragmentShader = 'uniform vec3 hairTarget; uniform float hairAmount;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\nfloat hairLight = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));\ndiffuseColor.rgb = mix(diffuseColor.rgb, clamp(hairTarget * hairLight * 2.5, 0.0, 1.0), hairAmount);');
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}:hair-color-v1`;
  material.needsUpdate = true;
  return (color: string | null) => { amount.value = color ? 1 : 0; if (color) target.value.set(color); };
}
