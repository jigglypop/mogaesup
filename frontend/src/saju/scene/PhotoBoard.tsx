import { useEffect, useState } from 'react';

import { SRGBColorSpace, TextureLoader, type Texture } from 'three';
import type { BoardPicture } from '../ui/PhotoBoardCard';
import { usePhotoAsset } from './works';

/** A brass-trimmed frame at the open side of the front court, facing the initial village camera. */
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
  const ratio = photo.width / photo.height;
  const w = Math.min(4.5, 2.7 * ratio);
  const h = Math.min(2.7, 4.5 / ratio);
  const center = 2.1;
  return (
    <group position={[-2.8, 0, 4.8]} rotation={[0, Math.PI / 4, 0]} userData={{ photoBoard: true }}>
      {[-1.65, 1.65].map((x) => <mesh key={x} position={[x, 0.5, 0]} castShadow>
        <boxGeometry args={[0.18, 1, 0.23]} /><meshStandardMaterial color="#685140" roughness={0.8} />
      </mesh>)}
      <mesh position={[0, center, 0]} castShadow receiveShadow>
        <boxGeometry args={[4.92, 3.04, 0.14]} /><meshStandardMaterial color="#bb975a" roughness={0.48} metalness={0.26} />
      </mesh>
      <mesh position={[0, center, 0.08]}>
        <boxGeometry args={[4.76, 2.88, 0.04]} /><meshStandardMaterial color="#232b30" />
      </mesh>
      {texture && <mesh position={[0, center, 0.105]}>
        <planeGeometry args={[w, h]} /><meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>}
    </group>
  );
}
