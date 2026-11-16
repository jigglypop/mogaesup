import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { BufferAttribute, BufferGeometry, DoubleSide, Matrix4, Mesh, MeshStandardMaterial, type Group, type Material, type Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { plainLook } from './kit';

// A guardian is some sixty small shapes, and a village has five: drawn one by one that is hundreds of draw calls a
// frame, each of them three times over (the picture, its shadows, the lake's mirror). The parts of it that move
// together are therefore drawn together: shapes of the same finish become one mesh, each keeping its colour in its
// vertices.

/** Marks a group as moving on its own: {@link Static} leaves it, and everything in it, as it is. */
export const MOVING = { moving: true } as const;
/** Marks the group a `Static` keeps its merged meshes in, which another `Static` around it must not take again. */
const MERGED = { merged: true } as const;

const painted = new Map<string, MeshStandardMaterial>();
/** The material that takes its colour from the vertices, for one finish. */
function paint(rough: number, metal: number, twoSided: boolean): MeshStandardMaterial {
  const key = `${rough}|${metal}|${twoSided}`;
  let material = painted.get(key);
  if (!material) {
    material = new MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: metal, ...(twoSided ? { side: DoubleSide } : {}) });
    painted.set(key, material);
  }
  return material;
}

/** A copy of a shape with only what merging needs (positions and normals, unindexed), moved by `matrix`. */
function placed(geometry: BufferGeometry, matrix: Matrix4): BufferGeometry {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const copy = new BufferGeometry();
  copy.setAttribute('position', source.getAttribute('position').clone());
  copy.setAttribute('normal', source.getAttribute('normal').clone());
  if (source !== geometry) source.dispose();
  return copy.applyMatrix4(matrix);
}

type Pile = { material: Material; cast: boolean; parts: BufferGeometry[] };

/**
 * Draws its children that do not move as a few meshes instead of one each. It looks through them once, when they are
 * first there: mount it under a `key` that changes when what it holds does. Groups marked {@link MOVING} are left out
 * (they may hold a `Static` of their own).
 */
export function Static({ children }: { children: ReactNode }) {
  const source = useRef<Group>(null);
  const merged = useRef<Group>(null);
  useLayoutEffect(() => {
    const root = source.current;
    const holder = merged.current;
    if (!root || !holder) return undefined;
    root.updateWorldMatrix(true, true);
    const toRoot = root.matrixWorld.clone().invert();
    const piles = new Map<string, Pile>();
    const taken: Mesh[] = [];
    const walk = (object: Object3D) => {
      if (object.userData['moving'] || object.userData['merged']) return;
      if (object instanceof Mesh && object.visible && object.material instanceof MeshStandardMaterial) {
        const material: MeshStandardMaterial = object.material;
        const geometry: BufferGeometry = object.geometry;
        const part = placed(geometry, new Matrix4().multiplyMatrices(toRoot, object.matrixWorld));
        const look = plainLook(material);
        let key: string;
        let drawn: Material;
        if (look) {
          // Plain paint: one mesh for every colour of this finish, the colour written into the vertices.
          const count = part.getAttribute('position').count;
          const colors = new Float32Array(count * 3);
          for (let index = 0; index < count; index++) material.color.toArray(colors, index * 3);
          part.setAttribute('color', new BufferAttribute(colors, 3));
          key = `paint|${look.rough}|${look.metal}|${look.twoSided}`;
          drawn = paint(look.rough, look.metal, look.twoSided);
        } else {
          // Something that glows or is see-through keeps its own material.
          key = material.uuid;
          drawn = material;
        }
        key += object.castShadow ? '|cast' : '';
        const pile = piles.get(key) ?? { material: drawn, cast: object.castShadow, parts: [] };
        pile.parts.push(part);
        piles.set(key, pile);
        taken.push(object);
      }
      for (const child of object.children) walk(child);
    };
    for (const child of root.children) walk(child);

    const made: Mesh[] = [];
    for (const pile of piles.values()) {
      const geometry = mergeGeometries(pile.parts, false);
      for (const part of pile.parts) part.dispose();
      if (!geometry) continue;
      const mesh = new Mesh(geometry, pile.material);
      mesh.castShadow = pile.cast;
      mesh.receiveShadow = true;
      holder.add(mesh);
      made.push(mesh);
    }
    for (const mesh of taken) mesh.visible = false;
    return () => {
      for (const mesh of taken) mesh.visible = true;
      for (const mesh of made) {
        holder.remove(mesh);
        mesh.geometry.dispose();
      }
    };
  }, []);
  return (
    <>
      <group ref={source}>{children}</group>
      <group ref={merged} userData={MERGED} />
    </>
  );
}
