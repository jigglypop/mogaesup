import { Matrix3, Matrix4, Vector3, type BufferAttribute, type BufferGeometry, type InterleavedBufferAttribute } from 'three';

export type PartEdit = { scale: [number, number, number]; translation: [number, number, number] };
/** Worn parts a member may resize and move, in the wardrobe's slot order: the server's `EDITABLE_SLOTS`. */
export const EDITABLE_PARTS = ['hair', 'hairFront', 'hairBack', 'hat', 'top', 'bottom', 'shoes', 'glasses'] as const;
/** The size along each axis, as a factor of the part's own (the server's `PartEdit::valid` holds the same). */
export const PART_SCALE = { min: .6, max: 1.5 } as const;
/** How far a part may move, in metres: across (x), up and down (y), front to back (z). */
export const PART_REACH = [.05, .15, .1] as const;
export const defaultPartEdit = (): PartEdit => ({ scale: [1, 1, 1], translation: [0, 0, 0] });
export const isDefaultPartEdit = (edit: PartEdit) => edit.scale.every(value => value === 1) && edit.translation.every(value => value === 0);
export function validPartEdit(edit: PartEdit) {
  return edit.scale.length === 3 && edit.translation.length === 3
    && edit.scale.every(value => Number.isFinite(value) && value >= PART_SCALE.min && value <= PART_SCALE.max)
    && edit.translation.every((value, axis) => Number.isFinite(value) && Math.abs(value) <= PART_REACH[axis]!);
}

/** Common body rest coordinates, matching the server's bake. The pivot is the source part's rest bounds centre. */
export function partEditMatrix(pivot: Vector3, edit: PartEdit): Matrix4 {
  if (!validPartEdit(edit)) throw new Error('파츠 크기와 위치 범위를 확인해 주세요.');
  return new Matrix4().makeScale(...edit.scale).setPosition(
    pivot.x * (1 - edit.scale[0]) + edit.translation[0],
    pivot.y * (1 - edit.scale[1]) + edit.translation[1],
    pivot.z * (1 - edit.scale[2]) + edit.translation[2]);
}

export type RestGeometry = { position: Float32Array; normal?: Float32Array; tangent?: Float32Array };
/** An attribute's own float values, `size` per vertex; none for quantized (integer or normalized) or interleaved data. */
function plainFloats(geometry: BufferGeometry, name: string, size: number) {
  const attribute = geometry.getAttribute(name) as BufferAttribute | InterleavedBufferAttribute | undefined;
  if (!attribute || (attribute as InterleavedBufferAttribute).isInterleavedBufferAttribute || attribute.normalized || attribute.itemSize !== size) return undefined;
  const array = (attribute as BufferAttribute).array;
  return array instanceof Float32Array && array.length === size * attribute.count ? array : undefined;
}
/** The rest buffers every edit starts from, or null when the positions are not plain float x, y, z: such a part (a
 * quantized or interleaved file) is worn as it is and never resized. */
export function restGeometry(geometry: BufferGeometry): RestGeometry | null {
  const position = plainFloats(geometry, 'position', 3);
  if (!position) return null;
  const normal = plainFloats(geometry, 'normal', 3), tangent = plainFloats(geometry, 'tangent', 4);
  return { position: position.slice(), ...(normal ? { normal: normal.slice() } : {}), ...(tangent ? { tangent: tangent.slice() } : {}) };
}

/** Rebuild from the saved rest/tucked buffers on every update; bone objects and bind matrices are never changed. */
export function editGeometry(geometry: BufferGeometry, rest: RestGeometry, positions: Float32Array, local: Matrix4) {
  const position = geometry.getAttribute('position') as BufferAttribute;
  if (local.equals(new Matrix4())) {
    position.array.set(positions); position.needsUpdate = true;
    for (const name of ['normal', 'tangent'] as const) {
      const attribute = geometry.getAttribute(name) as BufferAttribute | undefined;
      if (attribute && rest[name]) { attribute.array.set(rest[name]); attribute.needsUpdate = true; }
    }
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    return;
  }
  const point = new Vector3();
  for (let index = 0; index < position.count; index++) {
    point.fromArray(positions, 3 * index).applyMatrix4(local); position.setXYZ(index, point.x, point.y, point.z);
  }
  position.needsUpdate = true;
  const normal = geometry.getAttribute('normal') as BufferAttribute | undefined;
  if (normal && rest.normal) {
    const matrix = new Matrix3().getNormalMatrix(local);
    for (let index = 0; index < normal.count; index++) { point.fromArray(rest.normal, 3 * index).applyMatrix3(matrix).normalize(); normal.setXYZ(index, point.x, point.y, point.z); }
    normal.needsUpdate = true;
  }
  const tangent = geometry.getAttribute('tangent') as BufferAttribute | undefined;
  if (tangent && rest.tangent) {
    const matrix = new Matrix3().setFromMatrix4(local);
    for (let index = 0; index < tangent.count; index++) { point.fromArray(rest.tangent, 4 * index).applyMatrix3(matrix).normalize(); tangent.setXYZW(index, point.x, point.y, point.z, rest.tangent[4 * index + 3] ?? 1); }
    tangent.needsUpdate = true;
  }
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
}
