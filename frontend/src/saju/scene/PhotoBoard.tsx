import { useEffect, useMemo, useState } from 'react';

import { AdditiveBlending, BoxGeometry, CanvasTexture, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace, TextureLoader, type Texture } from 'three';

import type { BoardPicture } from '../ui/PhotoBoardCard';
import { containedSize } from './contain';
import { usePhotoAsset } from './works';

// A lit sign whose frame is cut to its photo: a wide photo makes a wide board, an upright one a tall one, the rim the same
// share of either. Light spills round it as from a lit screen at dusk.

/** The largest the photo is shown, in metres: a wide one as wide as this, an upright one as tall. */
const MOST = { w: 3.4, h: 2.4 };
/** The rim round the photo: this share of its longer side, and never thinner than the least. */
const RIM = 0.06;
const RIM_LEAST = 0.12;
/** How high the frame's foot stands on its posts. */
const STAND = 1.0;
/** How far the light round the frame reaches, in metres. */
const SPILL = 0.55;

/** Where a board its owner has not placed stands, and how it is turned: where every board stood before they could be moved. */
export const BOARD_SPOT = { x: -2.8, z: 4.8, turn: Math.PI / 4 } as const;

const UNIT_BOX = new BoxGeometry(1, 1, 1);
const UNIT_PLANE = new PlaneGeometry(1, 1);
const postMaterial = new MeshStandardMaterial({ color: '#2c343c', roughness: 0.55, metalness: 0.35 });
const bezelMaterial = new MeshStandardMaterial({ color: '#10161c', emissive: '#7ec8ff', emissiveIntensity: 0.3 });

/** The light round a frame `width` by `height` (metres): soft and warm outside its edge, clear inside it. */
function spillTexture(width: number, height: number): CanvasTexture {
  const scale = 96;
  const pad = Math.round(SPILL * scale);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(8, Math.round(width * scale) + pad * 2);
  canvas.height = Math.max(8, Math.round(height * scale) + pad * 2);
  const paper = canvas.getContext('2d');
  if (paper) {
    paper.shadowColor = 'rgba(255, 228, 170, 1)';
    paper.shadowBlur = pad * 0.9;
    paper.fillStyle = 'rgba(255, 236, 196, 0.9)';
    paper.fillRect(pad, pad, canvas.width - pad * 2, canvas.height - pad * 2);
    paper.shadowBlur = 0;
    // The frame stands over the middle: from behind, nothing glows through it.
    paper.globalCompositeOperation = 'destination-out';
    paper.fillRect(pad + 2, pad + 2, canvas.width - pad * 2 - 4, canvas.height - pad * 2 - 4);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** The photo's own size in pixels, once it has arrived (the server's word for it until then). */
function pixelSize(texture: Texture | null, photo: BoardPicture): { width: number; height: number } {
  const image = texture?.image as { width?: number; height?: number } | undefined;
  return { width: image?.width || photo.width, height: image?.height || photo.height };
}

/** The board, its foot at its own origin, facing +z. `tint` dyes its frame. */
export function PhotoBoard({ photo, tint }: { photo: BoardPicture; tint?: string | undefined }) {
  const [texture, setTexture] = useState<Texture | null>(null);
  // A photo that cannot be had is not waited for: a picture of the island is taken without it.
  const [failed, setFailed] = useState(false);
  usePhotoAsset(!!texture || failed);
  useEffect(() => {
    let live = true;
    setFailed(false);
    const loaded = new TextureLoader().load(
      photo.url,
      (map) => {
        if (!live) return;
        map.colorSpace = SRGBColorSpace;
        setTexture(map);
      },
      undefined,
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
      loaded.dispose();
    };
  }, [photo.url]);
  const { width, height } = pixelSize(texture, photo);
  const shown = containedSize(width, height, MOST.w, MOST.h);
  const rim = Math.max(RIM_LEAST, RIM * Math.max(shown.w, shown.h));
  const frame = { w: shown.w + rim * 2, h: shown.h + rim * 2 };
  const middle = STAND + frame.h / 2;
  const frameMaterial = useMemo(
    () => new MeshStandardMaterial({ color: tint ?? '#1c242c', roughness: 0.4, metalness: 0.45, emissive: '#f2d48a', emissiveIntensity: 0.22 }),
    [tint],
  );
  const spill = useMemo(() => spillTexture(frame.w, frame.h), [frame.w, frame.h]);
  const glow = useMemo(
    () => new MeshBasicMaterial({ map: spill, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, opacity: 0.85 }),
    [spill],
  );
  const picture = useMemo(() => (texture ? new MeshBasicMaterial({ map: texture, toneMapped: false }) : null), [texture]);
  useEffect(() => () => frameMaterial.dispose(), [frameMaterial]);
  useEffect(
    () => () => {
      glow.dispose();
      spill.dispose();
    },
    [glow, spill],
  );
  useEffect(() => () => picture?.dispose(), [picture]);
  const post = Math.max(0.12, frame.w / 2 - 0.16);
  return (
    <group userData={{ photoBoard: true }}>
      {[-post, post].map((x) => (
        <mesh key={x} geometry={UNIT_BOX} material={postMaterial} position={[x, (STAND + 0.3) / 2, 0]} scale={[0.12, STAND + 0.3, 0.16]} castShadow />
      ))}
      <mesh geometry={UNIT_BOX} material={frameMaterial} position={[0, middle, 0]} scale={[frame.w, frame.h, 0.12]} castShadow receiveShadow />
      <mesh geometry={UNIT_BOX} material={bezelMaterial} position={[0, middle, 0.065]} scale={[shown.w + 0.06, shown.h + 0.06, 0.02]} />
      {picture && <mesh geometry={UNIT_PLANE} material={picture} position={[0, middle, 0.08]} scale={[shown.w, shown.h, 1]} />}
      <mesh geometry={UNIT_PLANE} material={glow} position={[0, middle, 0.002]} scale={[frame.w + SPILL * 2, frame.h + SPILL * 2, 1]} renderOrder={3} raycast={() => undefined} />
    </group>
  );
}
