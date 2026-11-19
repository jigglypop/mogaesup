import { useLayoutEffect, useRef } from 'react';

import { Color, InstancedMesh, Object3D } from 'three';

import type { TerrainCell } from '../../api/types';

const FILL: Record<TerrainCell['terrain'], string> = {
  snow: '#e7f2f8',
  desert: '#e4b777',
  moss: '#5c8a4e',
};

const dummy = new Object3D();
const color = new Color();

/** The metres an owner painted, laid just over the lawn so the rest of the island keeps its own ground. */
export function TerrainPatches({ tiles }: { tiles: readonly TerrainCell[] }) {
  const mesh = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const current = mesh.current;
    if (!current) return;
    tiles.forEach((tile, index) => {
      dummy.position.set(tile.x + 0.5, 0.04, tile.z + 0.5);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(0.94, 1, 0.94);
      dummy.updateMatrix();
      current.setMatrixAt(index, dummy.matrix);
      current.setColorAt(index, color.set(FILL[tile.terrain]));
    });
    current.instanceMatrix.needsUpdate = true;
    if (current.instanceColor) current.instanceColor.needsUpdate = true;
  }, [tiles]);
  if (tiles.length === 0) return null;
  return (
    <instancedMesh key={tiles.length} ref={mesh} args={[undefined, undefined, tiles.length]} receiveShadow>
      <boxGeometry args={[1, 0.06, 1]} />
      <meshStandardMaterial roughness={0.92} vertexColors />
    </instancedMesh>
  );
}
