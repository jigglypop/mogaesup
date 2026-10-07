import { Color, MeshStandardMaterial } from 'three';
import { mix, texture, uniform, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';

import { ownProgramKey } from './program-key';

const LUMINANCE = [.2126, .7152, .0722] as const;
// Black texels still take a colour; for normal strands this only guards the division. The look's bake uses the same
// (server/src/look_bake.rs `hair_shade`).
const LIGHT_EPSILON = .0001;
const linear = (value: number) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
const LINEAR_BYTES = Float64Array.from({ length: 256 }, (_, value) => linear(value / 255));
const light = (color: Color) => color.r * LUMINANCE[0] + color.g * LUMINANCE[1] + color.b * LUMINANCE[2];

/** Mean linear light of a colour map's visible texels (RGBA bytes) times its material's colour, weighted by alpha. */
export function hairMapLight(pixels: ArrayLike<number>, tint: Color): number {
  let sum = 0, weight = 0;
  for (let at = 0; at + 3 < pixels.length; at += 4) {
    const alpha = (pixels[at + 3] ?? 0) / 255;
    if (!alpha) continue;
    sum += alpha * ((LINEAR_BYTES[pixels[at] ?? 0] ?? 0) * tint.r * LUMINANCE[0] +
      (LINEAR_BYTES[pixels[at + 1] ?? 0] ?? 0) * tint.g * LUMINANCE[1] + (LINEAR_BYTES[pixels[at + 2] ?? 0] ?? 0) * tint.b * LUMINANCE[2]);
    weight += alpha;
  }
  return weight ? sum / weight : light(tint);
}

/** A hair material's mean light: its decoded colour map read once (texture and UVs untouched), or its colour alone. */
export function hairMaterialLight(material: MeshStandardMaterial): number {
  const image = material.map?.image as { width?: number; height?: number; data?: ArrayLike<number> } | undefined;
  if (!image?.width || !image.height) return light(material.color);
  if (image.data) return hairMapLight(image.data, material.color);
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  // Without a 2D canvas the map cannot be read: its colour alone stands for it.
  if (!context) return light(material.color);
  context.drawImage(image as CanvasImageSource, 0, 0);
  return hairMapLight(context.getImageData(0, 0, canvas.width, canvas.height).data, material.color);
}

/**
 * Recolours hair in linear light, keeping its texture's alpha, its PBR maps and each strand's light relative to the
 * map's own mean: the mean texel takes the chosen colour, however dark or light the hair was, and brighter or darker
 * strands stay as much brighter or darker. The mean is read on the first colour chosen.
 */
export function hairColorControl(material: MeshStandardMaterial) {
  const target = uniform(new Color('#8a7998')), amount = uniform(0), reference = uniform(1);
  let measured = false;
  const sampled = material.map ? texture(material.map) : null;
  // A colour uniform is a vec3 in the shader; the typings keep it apart.
  const tint = uniform(material.color.clone()) as unknown as Node<'vec3'>;
  const original = sampled ? sampled.rgb.mul(tint) : tint;
  const luminance = original.dot(vec3(.2126, .7152, .0722));
  const recolored = mix(original, target.mul(luminance.add(LIGHT_EPSILON).div(reference)).clamp(0, 1), amount);
  Object.assign(material, { colorNode: sampled ? vec4(recolored, sampled.a) : recolored });
  const oldCompile = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    oldCompile(shader, renderer);
    shader.uniforms.hairTarget = { value: target.value };
    shader.uniforms.hairAmount = amount;
    shader.uniforms.hairReference = reference;
    shader.fragmentShader = 'uniform vec3 hairTarget; uniform float hairAmount; uniform float hairReference;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\nfloat hairLight = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));\ndiffuseColor.rgb = mix(diffuseColor.rgb, clamp(hairTarget * (hairLight + 0.0001) / hairReference, 0.0, 1.0), hairAmount);');
  };
  ownProgramKey(material, 'hair-color-v2');
  material.needsUpdate = true;
  return (color: string | null) => {
    if (color && !measured) { reference.value = hairMaterialLight(material) + LIGHT_EPSILON; measured = true; }
    amount.value = color ? 1 : 0;
    if (color) target.value.set(color);
  };
}
