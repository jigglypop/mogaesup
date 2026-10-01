import { MeshStandardMaterial, Texture } from 'three';
import { describe, expect, it } from 'vitest';

import { hairColorControl } from '../hair-color';
import { ownProgramKey } from '../program-key';
import { regionColorControl } from '../region-color';

/** A garment's material the way the glTF loader hands it over: a colour map, nothing else set. */
const garment = () => Object.assign(new MeshStandardMaterial(), { map: new Texture() });

describe('program keys of recoloured parts', () => {
  it('differ between garments that share every other flag', () => {
    const [hoodie, sneakers] = [garment(), garment()];
    const mask = new Texture();
    regionColorControl(hoodie, mask, [0.2]);
    regionColorControl(sneakers, mask, [0.2]);
    expect(hoodie.customProgramCacheKey()).not.toBe(sneakers.customProgramCacheKey());
  });

  it('differ between hairs', () => {
    const [first, second] = [garment(), garment()];
    hairColorControl(first);
    hairColorControl(second);
    expect(first.customProgramCacheKey()).not.toBe(second.customProgramCacheKey());
  });

  it('change when a control is rebuilt, without piling up on the key it had', () => {
    const hat = garment();
    const plain = hat.customProgramCacheKey();
    regionColorControl(hat, new Texture(), [0.3]);
    const first = hat.customProgramCacheKey();
    regionColorControl(hat, new Texture(), [0.3]);
    const second = hat.customProgramCacheKey();
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(first.length + 4);
    expect(first.startsWith(plain)).toBe(true);
  });

  it('keep what the material already told the renderer', () => {
    const material = garment();
    const before = material.customProgramCacheKey();
    ownProgramKey(material, 'tag');
    expect(material.customProgramCacheKey().startsWith(before)).toBe(true);
    expect(material.customProgramCacheKey()).toContain(material.uuid);
  });
});
