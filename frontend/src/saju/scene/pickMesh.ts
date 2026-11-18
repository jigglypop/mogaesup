import { Box3, BufferGeometry, Matrix4, Mesh, Ray, Sphere, Vector3, type Intersection, type Raycaster } from 'three';

// An estate batches thousands of roof tiles, planks and stones by material. Its one bounding sphere may span the
// whole island, but consecutive triangles still belong to nearby parts. Keep their bounds for subsequent presses.
const BLOCK = 128 * 3;
const nativeRaycast = Mesh.prototype.raycast;
const point = new Vector3();
const sphere = new Sphere();
const inverse = new Matrix4();
const localRay = new Ray();
const batches = new WeakMap<BufferGeometry, { boxes: Box3[]; proxy: Mesh }>();

/** Exact raycast for static, indexed Builder meshes. The draw geometry and its index order are never changed. */
export function pickBuiltMesh(this: Mesh, raycaster: Raycaster, hits: Intersection[]): void {
  const source = this.geometry;
  const index = source.index;
  if (!index || index.count < BLOCK * 4 || Array.isArray(this.material) || source.drawRange.start % 3 !== 0) {
    return nativeRaycast.call(this, raycaster, hits);
  }
  if (!source.boundingSphere) source.computeBoundingSphere();
  if (!raycaster.ray.intersectsSphere(sphere.copy(source.boundingSphere!).applyMatrix4(this.matrixWorld))) return;
  localRay.copy(raycaster.ray).applyMatrix4(inverse.copy(this.matrixWorld).invert());

  let batch = batches.get(source);
  if (!batch) {
    // A CPU-only view for the narrow-phase test. Three still handles face orientation, near/far, barycentrics and UVs.
    const view = new BufferGeometry();
    view.attributes = source.attributes;
    view.index = index;
    view.boundingSphere = source.boundingSphere;
    const positions = source.getAttribute('position');
    const boxes: Box3[] = [];
    for (let start = 0; start < index.count; start += BLOCK) {
      const box = new Box3();
      const end = Math.min(start + BLOCK, index.count);
      for (let i = start; i < end; i++) box.expandByPoint(point.fromBufferAttribute(positions, index.getX(i)));
      boxes.push(box);
    }
    batch = { boxes, proxy: new Mesh(view, this.material) };
    batches.set(source, batch);
  }

  const { boxes, proxy } = batch;
  proxy.matrixWorld.copy(this.matrixWorld);
  proxy.material = this.material;
  const was = hits.length;
  const range = source.drawRange;
  for (let block = 0; block < boxes.length; block++) {
    if (!localRay.intersectsBox(boxes[block]!)) continue;
    const start = Math.max(range.start, block * BLOCK);
    const end = Math.min(range.start + range.count, (block + 1) * BLOCK, index.count);
    if (end <= start) continue;
    proxy.geometry.setDrawRange(start, end - start);
    nativeRaycast.call(proxy, raycaster, hits);
  }
  for (let i = was; i < hits.length; i++) hits[i]!.object = this;
}
