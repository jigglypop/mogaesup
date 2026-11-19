import { useEffect, useState } from 'react';

import { SRGBColorSpace, TextureLoader, type Texture } from 'three';
import type { BoardPicture } from '../ui/PhotoBoardCard';
import { containedSize } from './contain';
import { usePhotoAsset } from './works';

const SCREEN = { w: 3.2, h: 1.8 };

function pixelSize(texture: Texture, photo: BoardPicture): { width: number; height: number } {
  const image = texture.image as { width?: number; height?: number } | undefined;
  return { width: image?.width || photo.width, height: image?.height || photo.height };
}

/** A lit sign at the open side of the front court. The photo sits inside the screen and keeps its shape. */
export function PhotoBoard({ photo }: { photo: BoardPicture }) {
  const [texture, setTexture] = useState<Texture | null>(null);
  usePhotoAsset(!!texture);
  useEffect(() => {
    let live = true;
    const loaded = new TextureLoader().load(photo.url, (map) => {
      if (live) {
        map.colorSpace = SRGBColorSpace;
        setTexture(map);
      }
    });
    return () => { live = false; loaded.dispose(); };
  }, [photo.url]);
  const fitted = texture ? containedSize(pixelSize(texture, photo).width, pixelSize(texture, photo).height, SCREEN.w, SCREEN.h) : null;
  const center = 2.1;
  return (
    <group position={[-2.8, 0, 4.8]} rotation={[0, Math.PI / 4, 0]} userData={{ photoBoard: true }}>
      {[-1.82, 1.82].map((x) => <mesh key={x} position={[x, 0.55, 0]} castShadow>
        <boxGeometry args={[0.14, 1.1, 0.18]} /><meshStandardMaterial color="#2c343c" roughness={0.55} metalness={0.35} />
      </mesh>)}
      <mesh position={[0, center, 0]} castShadow receiveShadow>
        <boxGeometry args={[4.05, 2.35, 0.12]} /><meshStandardMaterial color="#1c242c" roughness={0.4} metalness={0.45} emissive="#f2d48a" emissiveIntensity={0.18} />
      </mesh>
      <mesh position={[0, center, 0.07]}>
        <boxGeometry args={[SCREEN.w + 0.08, SCREEN.h + 0.08, 0.04]} /><meshStandardMaterial color="#10161c" emissive="#7ec8ff" emissiveIntensity={0.22} />
      </mesh>
      {texture && fitted && <mesh position={[0, center, 0.1]}>
        <planeGeometry args={[fitted.w, fitted.h]} /><meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>}
    </group>
  );
}
