import { useEffect, useMemo, useRef, type RefObject } from 'react';

import { useFrame } from '@react-three/fiber';
import { CanvasTexture, MeshBasicMaterial, PlaneGeometry, RepeatWrapping, SRGBColorSpace, type Mesh } from 'three';

import type { CellRect } from '../tiles';

/** One cell's square: its edge drawn round and hatched on the slant, transparent between the lines. */
function hatchTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const paper = canvas.getContext('2d');
  if (paper) {
    paper.clearRect(0, 0, size, size);
    paper.lineCap = 'square';
    paper.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    paper.lineWidth = 2;
    for (let along = -size; along < size; along += 11) {
      paper.beginPath();
      paper.moveTo(along, size);
      paper.lineTo(along + size, 0);
      paper.stroke();
    }
    paper.strokeStyle = 'rgba(255, 255, 255, 0.98)';
    paper.lineWidth = 4;
    paper.strokeRect(2, 2, size - 4, size - 4);
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const PLANE = new PlaneGeometry(1, 1);
/** Over the ground and what is painted on it, under anything standing. */
const OVER = 0.05;
const NOTHING = () => undefined;

/**
 * Where the owner is laying a terrain: the cells of `rect` (on the island at the village's middle), each a hatched
 * square, read every frame; nothing while it is null.
 */
export function CellCursor({ rect }: { rect: RefObject<CellRect | null> }) {
  const mesh = useRef<Mesh>(null);
  const texture = useMemo(hatchTexture, []);
  const material = useMemo(
    () => new MeshBasicMaterial({ map: texture, color: '#fff3c8', transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    [texture],
  );
  useEffect(
    () => () => {
      material.dispose();
      texture.dispose();
    },
    [material, texture],
  );
  useFrame(() => {
    const shown = mesh.current;
    if (!shown) return;
    const cells = rect.current;
    shown.visible = !!cells;
    if (!cells) return;
    const wide = cells.x1 - cells.x0 + 1;
    const deep = cells.z1 - cells.z0 + 1;
    shown.position.set(cells.x0 + wide / 2, OVER, cells.z0 + deep / 2);
    shown.scale.set(wide, deep, 1);
    texture.repeat.set(wide, deep);
  });
  return <mesh ref={mesh} geometry={PLANE} material={material} rotation={[-Math.PI / 2, 0, 0]} renderOrder={5} visible={false} raycast={NOTHING} />;
}
