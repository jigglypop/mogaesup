import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, type Texture } from 'three';

import { paint } from './painter';
import { paintSurface, surfaceSize, TILE, type Surface } from './surfaceRecipes';

// What things are made of, close up (see surfaceRecipes): the textures a material wears, handed out at once and filled
// when the painter has painted them, off the main thread (see painter).

export type { Surface } from './surfaceRecipes';
export type SurfaceMaps = { map: Texture; normalMap: Texture; size: number };

const made = new Map<Surface, SurfaceMaps>();

function tiled(data: Uint8Array, srgb: boolean): DataTexture {
  const texture = new DataTexture(data, TILE, TILE, RGBAFormat);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Gives `texture` the texels painted for it. */
function fill(texture: DataTexture, data: Uint8Array): void {
  texture.image = { data, width: TILE, height: TILE };
  texture.needsUpdate = true;
}

/** A tile of one texel value over and over: what a texture holds until its own is painted. */
function plain(r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(TILE * TILE * 4);
  for (let at = 0; at < data.length; at += 4) {
    data[at] = r;
    data[at + 1] = g;
    data[at + 2] = b;
    data[at + 3] = 255;
  }
  return data;
}

/** A surface's colour and relief tiles and the metres they cover, painted once (see painter). */
export function surfaceMaps(surface: Exclude<Surface, 'plain'>): SurfaceMaps {
  const known = made.get(surface);
  if (known) return known;
  const map = tiled(plain(220, 220, 220), true);
  const normalMap = tiled(plain(128, 128, 255), false);
  const maps = { map, normalMap, size: surfaceSize(surface) };
  made.set(surface, maps);
  paint(
    { kind: 'surface', surface },
    () => {
      const { colors, normals } = paintSurface(surface);
      return [colors, normals];
    },
    ([colors, normals]) => {
      fill(map, colors!);
      fill(normalMap, normals!);
    },
  );
  return maps;
}
