import { BackSide, DoubleSide, FrontSide, Mesh, MeshBasicMaterial, PlaneGeometry, Raycaster, Vector3, type Intersection } from 'three';
import { describe, expect, it } from 'vitest';

import { pickBuiltMesh } from '../scene/pickMesh';

describe('섬을 눌러 초점 잡기', () => {
  it('재질, 거리, 그리는 면의 범위와 메쉬 변환을 반영해 동일한 교차점을 돌려준다', () => {
    const mesh = new Mesh(new PlaneGeometry(16, 12, 48, 32), new MeshBasicMaterial());
    mesh.position.set(7, -2, 1);
    mesh.scale.set(2, 0.7, 1.5);
    mesh.rotation.set(0.23, 0.7, -1);
    mesh.updateMatrixWorld();
    const front = new Vector3(0, 0, 1).transformDirection(mesh.matrixWorld);
    let counted = 0;
    for (const start of [0, 390, 391]) {
      const count = start === 0 ? Infinity : 606;
      mesh.geometry.setDrawRange(start, count);
      for (const side of [FrontSide, BackSide, DoubleSide] as const) {
        mesh.material.side = side;
        for (const [x, y] of [[0.2, 0.9], [2.3, 5.2], [22, -2]] as const) {
          const target = mesh.localToWorld(new Vector3(x, y, 0));
          for (const [distance, far] of [[4, 6], [-4, 6], [4, 3]] as const) {
            const origin = target.clone().addScaledVector(front, distance);
            const ray = new Raycaster(origin, target.clone().sub(origin).normalize(), 0.5, far);
            const expected: Intersection[] = [];
            const actual: Intersection[] = [];
            Mesh.prototype.raycast.call(mesh, ray, expected);
            pickBuiltMesh.call(mesh, ray, actual);
            expect(actual).toEqual(expected);
            counted += expected.length;
          }
        }
      }
      expect(mesh.geometry.drawRange).toEqual({ start, count });
    }
    expect(counted).toBeGreaterThan(0);
    mesh.geometry.dispose();
    mesh.material.dispose();
  });
});
