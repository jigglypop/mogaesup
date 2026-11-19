import { useEffect, useMemo, useState } from 'react';

import { Box3, CanvasTexture, Color, CylinderGeometry, DoubleSide, Mesh, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace, Vector3, type Material, type Object3D } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { float, positionGeometry, sin, uv, vec3 } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';

import type { DecorFlag, DecorGift, DecorItem, FlagDesign, Terrain, TerrainCell } from '../../api/types';
import type { PropRef } from '../decor';
import { elementPiece } from '../elementalDecor';
import { CompatGiftObject } from './CompatGiftObject';
import type { BoardPicture } from '../ui/PhotoBoardCard';
import { BOARD_SPOT, PhotoBoard } from './PhotoBoard';
import { ElementOrnament } from './ElementOrnament';
import { barrel, bench, jar, lantern, parasol, pot, tableSet, well, woodpile } from './arch';
import { Builder, type Build } from './build';
import { Built } from './Built';
import { loadDecorModel } from './decorModel';
import { keptBuild } from './kept';
import { bush, rock, tree } from './plants';
import { wind } from './sprigs';
import { usePhotoAsset } from './works';

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
function clothOf(star: string, element: FlagDesign['element'], tint?: string): MeshStandardNodeMaterial {
  const dye = DYES[element];
  const shade = new Color(tint ?? dye.cloth);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 170;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = tint ?? dye.cloth;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = tint ? (shade.r * 0.213 + shade.g * 0.715 + shade.b * 0.072 > 0.36 ? '#281d2e' : '#fff7ef') : dye.ink;
    context.lineWidth = 6;
    context.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
    context.fillStyle = context.strokeStyle;
    context.font = '800 76px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(star, canvas.width / 2, canvas.height / 2 + 4);
  }
  const picture = new CanvasTexture(canvas);
  picture.colorSpace = SRGBColorSpace;
  const material = new MeshStandardNodeMaterial({ map: picture, roughness: 0.85, side: DoubleSide });
  const out = uv().x;
  const wave = sin(wind.mul(4.2).sub(out.mul(5.5))).mul(out).mul(0.09).add(sin(wind.mul(2.3).sub(out.mul(3.1))).mul(out).mul(0.04));
  material.positionNode = positionGeometry.add(vec3(float(0), wave.mul(0.35), wave));
  return material;
}

function FlagPole({ design: { star, element }, tint }: { design: FlagDesign; tint?: string }) {
  const cloth = useMemo(() => clothOf(star, element, tint), [star, element, tint]);
  useEffect(() => () => { cloth.map?.dispose(); cloth.dispose(); }, [cloth]);
  return (
    <group>
      <mesh geometry={POLE} material={poleMaterial} castShadow receiveShadow />
      <mesh geometry={CLOTH} material={cloth} position={[0.03, 1.42, 0]} castShadow />
    </group>
  );
}

/** A small thing for the garden, built as the island's own are (see build), about its middle. */
function propBuild(ref: PropRef, tint?: string): Build {
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
  const build = b.finish();
  if (tint) {
    const paint = new Color(tint);
    const dye = (colors: Float32Array) => {
      for (let i = 0; i < colors.length; i += 3) {
        const light = Math.min(1.3, 0.28 + Math.sqrt(Math.max(colors[i]!, colors[i + 1]!, colors[i + 2]!)));
        colors[i] = paint.r * light;
        colors[i + 1] = paint.g * light;
        colors[i + 2] = paint.b * light;
      }
    };
    for (const mesh of build.meshes) {
      const colors = mesh.geometry.getAttribute('color')?.array;
      if (colors instanceof Float32Array) dye(colors);
    }
    for (const sprigs of build.sprigs) dye(sprigs.colors);
  }
  return build;
}

function PropItem({ name, tint }: { name: PropRef; tint?: string }) {
  const [build, setBuild] = useState<Build | null>(null);
  // One that cannot be built is not waited for: a picture of the island is taken without it.
  const [failed, setFailed] = useState(false);
  usePhotoAsset(!!build || failed);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => keptBuild(`decor|${name}|${tint ?? ''}`, () => propBuild(name, tint))).then((made) => {
      if (live) setBuild(made);
    }, () => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [name, tint]);
  return build && <Built build={build} origin={[0, 0, 0]} />;
}

/** How tall the owner's character stands on the island, in metres: as tall as the house's door. */
const CHARACTER_HEIGHT = 1.05;
const box = new Box3();
const size = new Vector3();

function Character({ url, tint }: { url: string; tint?: string }) {
  const [model, setModel] = useState<Object3D | null>(null);
  // A character whose model cannot be had (a look taken away) is not waited for either.
  const [failed, setFailed] = useState(false);
  usePhotoAsset(!!model || failed);
  useEffect(() => {
    let live = true;
    const dyed = new Map<Material, Material>();
    const materialOf = (material: Material) => {
      if (!tint || !(material instanceof MeshStandardMaterial)) return material;
      let copy = dyed.get(material);
      if (!copy) {
        const colored = material.clone();
        colored.color.set(tint);
        dyed.set(material, colored);
        copy = colored;
      }
      return copy;
    };
    loadDecorModel(url).then(
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
          if (part instanceof Mesh && tint) part.material = Array.isArray(part.material) ? part.material.map(materialOf) : materialOf(part.material);
        });
        setModel(copy);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
      for (const material of dyed.values()) material.dispose();
    };
  }, [url, tint]);
  return model && <primitive object={model} />;
}

/** What is placed on the 섬 whose island stands at the village's middle. */
export type IslandDecor = { items: readonly DecorItem[]; flags: readonly DecorFlag[]; gifts?: readonly DecorGift[]; terrain?: Terrain; tiles?: readonly TerrainCell[]; own: FlagDesign | null; character: string | null; photoBoard?: BoardPicture | null };
export function DecorLayer({ items, flags, gifts, own, character, selectedId, photoBoard }: IslandDecor & { selectedId: string | null }) {
  // A board its owner has not placed stands where boards stood before they could be moved.
  const boardPlaced = items.some((item) => item.kind === 'board');
  return (
    <group>
      {photoBoard && !boardPlaced && (
        <group position={[BOARD_SPOT.x, 0, BOARD_SPOT.z]} rotation={[0, BOARD_SPOT.turn, 0]}>
          <PhotoBoard key={photoBoard.url} photo={photoBoard} />
        </group>
      )}
      {items.map((item) => {
        let shown = null;
        if (item.kind === 'flag') {
          const design = item.ref === 'mine' ? own : (flags.find((flag) => flag.id === item.ref)?.design ?? null);
          shown = design && <FlagPole design={design} tint={item.color} />;
        } else if (item.kind === 'prop') {
          const piece = elementPiece(item.ref);
          shown = piece ? <ElementOrnament piece={piece} color={item.color} /> : <PropItem name={item.ref as PropRef} tint={item.color} />;
        } else if (item.kind === 'gift') {
          const gift = gifts?.find((one) => one.id === item.ref);
          shown = gift && <CompatGiftObject design={gift.design} tint={item.color} />;
        } else if (item.kind === 'character' && character) {
          shown = <Character url={character} tint={item.color} />;
        } else if (item.kind === 'board' && photoBoard) {
          shown = <PhotoBoard key={photoBoard.url} photo={photoBoard} tint={item.color} />;
        }
        return (
          shown && (
            <group key={item.id} position={[item.x, 0, item.z]} rotation={[0, item.turn, 0]} scale={item.scale ?? 1} userData={{ decorId: item.id }}>
              {shown}
              {/* A rock is drawn entirely as a shader instance, which the scene's solid-mesh picker passes through. */}
              {item.kind === 'prop' && item.ref === 'rock' && <mesh position={[0, 0.09, 0]} scale={[0.66, 0.4, 0.66]}>
                <sphereGeometry args={[1, 8, 6]} />
                <meshBasicMaterial visible={false} />
              </mesh>}
              {item.id === selectedId && <mesh position={[0, 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={20} raycast={() => {}}>
                <ringGeometry args={[0.76, 0.86, 64]} />
                <meshBasicMaterial color="#ece5ff" transparent opacity={0.95} depthTest={false} depthWrite={false} />
              </mesh>}
            </group>
          )
        );
      })}
    </group>
  );
}
