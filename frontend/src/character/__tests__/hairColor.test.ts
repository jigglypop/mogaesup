import { Color, DataTexture, MeshStandardMaterial, Texture, type WebGLRenderer, type WebGLProgramParametersWithUniforms } from 'three';
import { describe, expect, it } from 'vitest';

import { hairColorControl, hairMapLight, hairMaterialLight } from '../hair-color';

/** The dyed colour the bake writes for one texel (server/src/look_bake.rs `hair_shade`), in linear light. */
const shade = (texel: number, reference: number, target: Color) => {
  const factor = (texel + .0001) / (reference + .0001);
  return [target.r, target.g, target.b].map(channel => Math.min(1, channel * factor));
};

function compiled(material: MeshStandardMaterial) {
  const shader = { uniforms: {}, fragmentShader: '#include <map_fragment>' } as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as WebGLRenderer);
  return shader;
}

describe('hair colour light reference', () => {
  it('reads linear light and the material tint, excluding transparent atlas pixels', () => {
    const tint = new Color(.5, .5, .5);
    const gray = new Color('#808080');
    const pixels = new Uint8Array([128, 128, 128, 255, 255, 255, 255, 0]);
    expect(hairMapLight(pixels, tint)).toBeCloseTo(gray.r * .5, 7);
    const material = new MeshStandardMaterial({ color: tint, map: new DataTexture(pixels, 2, 1) });
    expect(hairMaterialLight(material)).toBeCloseTo(gray.r * .5, 7);
  });

  it('weights translucent strands and safely handles an empty visible map', () => {
    const tint = new Color(.2, .2, .2);
    expect(hairMapLight([0, 0, 0, 255, 255, 255, 255, 128], tint)).toBeCloseTo(.2 * 128 / 383, 8);
    expect(hairMapLight([255, 255, 255, 0], tint)).toBeCloseTo(.2, 8);
  });

  it('gives solid black hair its own zero reference so it can take a colour', () => {
    expect(hairMaterialLight(new MeshStandardMaterial({ color: '#000000' }))).toBe(0);
  });

  it('dyes the mean texel the chosen colour, as dark or as light as the hair was', () => {
    const target = new Color('#f0d080');
    // The old shade (target times the strand light times 2.5) left black hair black and burnt blond hair white.
    for (const byte of [8, 40, 128, 230]) {
      const material = new MeshStandardMaterial({ map: new DataTexture(new Uint8Array([byte, byte, byte, 255]), 1, 1) });
      const reference = hairMaterialLight(material);
      const [r, g, b] = shade(reference, reference, target);
      expect(r).toBeCloseTo(target.r, 6); expect(g).toBeCloseTo(target.g, 6); expect(b).toBeCloseTo(target.b, 6);
    }
  });

  it('reads the map once the first colour is chosen and restores the original map, alpha and PBR maps', () => {
    const map = new DataTexture(new Uint8Array([64, 64, 64, 255]), 1, 1);
    const normalMap = new Texture();
    const material = new MeshStandardMaterial({ map, normalMap, transparent: true, opacity: .7 });
    const source = material.color.clone(), originalLight = hairMaterialLight(material);
    const update = hairColorControl(material);
    const shader = compiled(material);
    update(null);
    expect(shader.uniforms.hairReference!.value).toBe(1);
    update('#f0d080');
    expect(shader.uniforms.hairTarget!.value).toEqual(new Color('#f0d080'));
    expect(shader.uniforms.hairAmount!.value).toBe(1);
    expect(shader.uniforms.hairReference!.value).toBeCloseTo(originalLight + .0001, 8);
    expect(shader.fragmentShader).toContain('(hairLight + 0.0001) / hairReference');
    update(null);
    expect(shader.uniforms.hairAmount!.value).toBe(0);
    expect(material.map).toBe(map);
    expect(material.normalMap).toBe(normalMap);
    expect(material.color).toEqual(source);
    expect(material.opacity).toBe(.7);
  });

  it('keeps each material its own reference: a flat scalp cap takes the chosen colour like the strands around it', () => {
    const strands = new MeshStandardMaterial({ map: new DataTexture(new Uint8Array([20, 20, 20, 255]), 1, 1) });
    const cap = new MeshStandardMaterial({ color: new Color(.01, .01, .01) });
    const references = [strands, cap].map(material => {
      const update = hairColorControl(material), shader = compiled(material);
      update('#ad8fe8');
      return shader.uniforms.hairReference!.value as number;
    });
    expect(references[0]).toBeCloseTo(hairMaterialLight(strands) + .0001, 8);
    expect(references[1]).toBeCloseTo(.01 + .0001, 8);
  });
});
