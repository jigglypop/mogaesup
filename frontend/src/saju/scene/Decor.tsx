import { useEffect, useMemo, useState } from 'react';

import { Box3, CanvasTexture, CylinderGeometry, DoubleSide, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace, Vector3, type Object3D } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { float, positionGeometry, sin, uv, vec3 } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';

import type { DecorFlag, DecorItem, FlagDesign } from '../../api/types';
import type { PropRef } from '../decor';
import { barrel, bench, jar, lantern, parasol, pot, tableSet, well, woodpile } from './arch';
import { Builder, type Build } from './build';
import { Built } from './Built';
import { keptBuild } from './kept';
import { bush, rock, tree } from './plants';
import { wind } from './sprigs';

// What its owner has placed on a 섬 (see ../decor), standing on its lawn: flags on poles waving in the sea's wind, small
// things for the garden built as the island's own are, and the owner's character from the studio.

/** The colours a flag is dyed in, by the element of its 오행국. */
const DYES: Record<FlagDesign['element'], { cloth: string; ink: string }> = {
  wood: { cloth: '#2f8a57', ink: '#f4f1e4' },
  fire: { cloth: '#c8432f', ink: '#fff3e2' },
  earth: { cloth: '#c79a2c', ink: '#3b2a12' },
  metal: { cloth: '#e7e3da', ink: '#3a3d45' },
  water: { cloth: '#27508f', ink: '#eef3fb' },
};

const POLE = new CylinderGeometry(0.028, 0.034, 1.7, 10);
POLE.translate(0, 0.85, 0);
const CLOTH = new PlaneGeometry(0.78, 0.52, 12, 4);
CLOTH.translate(0.39, 0, 0);
const poleMaterial = new MeshStandardMaterial({ color: '#6b5440', roughness: 0.8 });

/** A flag's cloth: dyed, the star's name on it, waving out from its pole more the farther from it. */
const cloths = new Map<string, MeshStandardNodeMaterial>();
function clothOf(design: FlagDesign): MeshStandardNodeMaterial {
  const key = `${design.star}|${design.element}`;
  const known = cloths.get(key);
  if (known) return known;
  const dye = DYES[design.element];
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 170;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = dye.cloth;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = dye.ink;
    context.lineWidth = 6;
    context.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
    context.fillStyle = dye.ink;
    context.font = '800 76px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(design.star, canvas.width / 2, canvas.height / 2 + 4);
  }
  const picture = new CanvasTexture(canvas);
  picture.colorSpace = SRGBColorSpace;
  const material = new MeshStandardNodeMaterial({ map: picture, roughness: 0.85, side: DoubleSide });
  const out = uv().x;
  const wave = sin(wind.mul(4.2).sub(out.mul(5.5))).mul(out).mul(0.09).add(sin(wind.mul(2.3).sub(out.mul(3.1))).mul(out).mul(0.04));
  material.positionNode = positionGeometry.add(vec3(float(0), wave.mul(0.35), wave));
  cloths.set(key, material);
  return material;
}

function FlagPole({ design }: { design: FlagDesign }) {
  const cloth = useMemo(() => clothOf(design), [design]);
  return (
    <group>
      <mesh geometry={POLE} material={poleMaterial} castShadow receiveShadow />
      <mesh geometry={CLOTH} material={cloth} position={[0.03, 1.42, 0]} castShadow />
    </group>
  );
}

/** A small thing for the garden, built as the island's own are (see build), about its middle. */
function propBuild(ref: PropRef): Build {
  const b = new Builder(ref.length * 97 + ref.charCodeAt(0));
  switch (ref) {
    case 'lantern':
      lantern(b, [0, 0, 0], { kind: 'stone' });
      break;
    case 'bench':
      bench(b, [0, 0, 0]);
      break;
    case 'jar':
      jar(b, [-0.25, 0, 0], 1.1);
      jar(b, [0.3, 0, 0.1], 0.8);
      break;
    case 'pot':
      pot(b, [0, 0, 0], 1.2, ['#4f8a3c', '#62a04a', '#3f7a33'], ['#f2a5c0', '#ffd36e', '#f6f0e4']);
      break;
    case 'barrel':
      barrel(b, [0, 0, 0], 1.1);
      break;
    case 'woodpile':
      woodpile(b, [0, 0, 0]);
      break;
    case 'table':
      tableSet(b, [0, 0, 0], 2);
      break;
    case 'parasol':
      parasol(b, [0, 0, 0]);
      break;
    case 'well':
      well(b, [0, 0, 0], { cover: { kind: 'shingle', shingles: ['#6e5440', '#7d604a', '#634b39'] } });
      break;
    case 'bush':
      bush(b, [0, 0, 0], 0.55, ['#4f8a3c', '#62a04a', '#3f7a33', '#6fae54'], { colors: ['#f6c7d6', '#fff2f2'], count: 10 });
      break;
    case 'rock':
      rock(b, [0, 0, 0], 0.7, '#a59c8e', 0.65);
      break;
    case 'tree':
      tree(b, [0, 0, 0], { height: 3.2, spread: 2.4, bark: '#5a4034', leaves: ['#5f9a45', '#76ad52', '#4e8a3b', '#8cbd5c'], lobes: 4 });
      break;
  }
  return b.finish();
}

function PropItem({ name }: { name: PropRef }) {
  const [build, setBuild] = useState<Build | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve(keptBuild(`decor|${name}`, () => propBuild(name))).then((made) => {
      if (live) setBuild(made);
    });
    return () => {
      live = false;
    };
  }, [name]);
  return build && <Built build={build} origin={[0, 0, 0]} />;
}

/** How tall the owner's character stands on the island, in metres: as tall as the house's door. */
const CHARACTER_HEIGHT = 1.05;
const characters = new Map<string, Promise<Object3D>>();
const box = new Box3();
const size = new Vector3();

function loadCharacter(url: string): Promise<Object3D> {
  let model = characters.get(url);
  if (!model) {
    model = new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .loadAsync(url)
      .then((gltf) => gltf.scene);
    characters.set(url, model);
    model.catch(() => characters.delete(url));
  }
  return model;
}

function Character({ url }: { url: string }) {
  const [model, setModel] = useState<Object3D | null>(null);
  useEffect(() => {
    let live = true;
    loadCharacter(url).then(
      (scene) => {
        if (!live) return;
        const copy = cloneSkinned(scene);
        box.setFromObject(copy).getSize(size);
        const scale = size.y > 0 ? CHARACTER_HEIGHT / size.y : 1;
        copy.scale.setScalar(scale);
        box.setFromObject(copy);
        copy.position.y -= box.min.y;
        copy.traverse((part) => {
          part.castShadow = true;
          part.receiveShadow = true;
        });
        setModel(copy);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [url]);
  return model && <primitive object={model} />;
}

/** What is placed on the 섬 whose island stands at the village's middle. */
export function DecorLayer({ items, flags, own, character }: { items: readonly DecorItem[]; flags: readonly DecorFlag[]; own: FlagDesign | null; character: string | null }) {
  return (
    <group>
      {items.map((item) => {
        let shown = null;
        if (item.kind === 'flag') {
          const design = item.ref === 'mine' ? own : (flags.find((flag) => flag.id === item.ref)?.design ?? null);
          shown = design && <FlagPole design={design} />;
        } else if (item.kind === 'prop') {
          shown = <PropItem name={item.ref as PropRef} />;
        } else if (item.kind === 'character' && character) {
          shown = <Character url={character} />;
        }
        return (
          shown && (
            <group key={item.id} position={[item.x, 0, item.z]} rotation={[0, item.turn, 0]}>
              {shown}
            </group>
          )
        );
      })}
    </group>
  );
}
