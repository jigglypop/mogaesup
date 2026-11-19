import { useEffect, useState } from 'react';
import { Color, Mesh, MeshStandardMaterial, type Object3D } from 'three';

import type { GiftDesign } from '../../api/types';
import { GIFT_FORMS, GIFT_STONES } from '../gifts';
import { loadDecorModel } from './decorModel';
import { usePhotoAsset } from './works';

/** The two stones form a plinth for the shape chosen by 궁합. Matching elements have two lanterns on one plinth. */
export function CompatGiftObject({ design, tint }: { design: GiftDesign; tint?: string }) {
  const { tone, from, to } = design;
  const first = tint ?? GIFT_STONES[from].color;
  const second = GIFT_STONES[to].color;
  const [models, setModels] = useState<Object3D[]>([]);
  // A model that could not be had is not waited for: the picture is taken without it, as the island shows it.
  const [failed, setFailed] = useState(false);
  usePhotoAsset(models.length > 0 || failed);
  useEffect(() => {
    let live = true;
    const dyed: MeshStandardMaterial[] = [];
    loadDecorModel(`/gltf/decor/${GIFT_FORMS[tone].model}.glb`).then((template) => {
      if (!live) return;
      const dress = (tintColor: string) => {
        const model = template.clone(true);
        model.traverse((part) => {
          if (!(part instanceof Mesh)) return;
          part.castShadow = true;
          part.receiveShadow = true;
          if (part.material instanceof MeshStandardMaterial) {
            const material = part.material.clone();
            material.color.multiply(new Color(tintColor).lerp(new Color('white'), 0.45));
            part.material = material;
            dyed.push(material);
          }
        });
        return model;
      };
      setModels(tone === 'same' ? [dress(first), dress(second)] : [dress(first)]);
    }, () => {
      if (!live) return;
      setModels([]);
      setFailed(true);
    });
    return () => {
      live = false;
      for (const material of dyed) material.dispose();
    };
  }, [tone, first, second]);
  const radius = { union: 1.25, flow: 0.93, same: 0.87, spark: 0.66 }[tone];
  return (
    <group>
      <mesh position={[0, 0.055, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius * 1.04, 0.11, 8]} />
        <meshStandardMaterial color={second} roughness={0.38} metalness={0.22} />
      </mesh>
      <mesh position={[0, 0.135, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[radius * 0.93, radius * 0.96, 0.05, 8]} />
        <meshStandardMaterial color={first} roughness={0.42} metalness={0.2} />
      </mesh>
      {models.map((model, i) => (
        <group key={model.uuid} position={[tone === 'same' ? (i === 0 ? -0.39 : 0.39) : 0, 0.16, 0]} scale={tone === 'same' ? 0.78 : 1}>
          <primitive object={model} />
        </group>
      ))}
    </group>
  );
}
