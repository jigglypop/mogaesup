import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three';

import { paint } from '../painter';
import { detailData, foamData, SEA_TILE } from './seaTiles';

// The lake's two tiles (see seaTiles), handed out at once and filled when the painter has painted them, off the main
// thread (see ../painter).

function tile(data: Uint8Array, size: number) {
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 1;
  texture.needsUpdate = true;
  return texture;
}

/** A tile of flat, still water (no slope, mid height, no foam) until the painter's comes. */
function calm(): DataTexture {
  const data = new Uint8Array(SEA_TILE * SEA_TILE * 4);
  for (let at = 0; at < data.length; at += 4) data.set([128, 128, 128, 255], at);
  return tile(data, SEA_TILE);
}

function painted(texture: DataTexture, [data]: Uint8Array[]): void {
  texture.image = { data: data!, width: SEA_TILE, height: SEA_TILE };
  texture.needsUpdate = true;
}

let detail: DataTexture | null = null;
let foam: DataTexture | null = null;

/** The ripple tile, made once for the village's wind. */
export function detailTexture(windAngle: number): DataTexture {
  if (detail) return detail;
  const texture = (detail = calm());
  paint({ kind: 'detail', windAngle }, () => [detailData(windAngle)], (data) => painted(texture, data));
  return texture;
}

/** The foam tile, made once. */
export function foamTexture(): DataTexture {
  if (foam) return foam;
  const texture = (foam = calm());
  paint({ kind: 'foam' }, () => [foamData()], (data) => painted(texture, data));
  return texture;
}
