import { Box3, BufferAttribute, Group, Matrix4, MeshStandardMaterial, Skeleton, Vector3, type Bone, type Object3D, type SkinnedMesh, type Material, type Texture, type BufferGeometry } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { disposeObjectResources } from './assets/gpu-resources';
import { downloadBytes } from './assets/download';
import { loadFailure } from './assets/load-failure';
import { hairColorControl } from './hair-color';
import { regionColorControl } from './region-color';
import { matteCharacter } from './matte-materials';
import { hasConflictingPartSlots } from './factory/parts';
import { defaultPartEdit, EDITABLE_PARTS, editGeometry, isDefaultPartEdit, partEditMatrix, restGeometry, validPartEdit, type PartEdit, type RestGeometry } from './part-edit';

export type Wearable = { id: string; slot: string; url: string; sha256: string };
/** An inner garment's tuck: per "mesh:primitive", the body vertex under each vertex (index into keys
 * << 20 | vertex, -1 for none) and the vertex-space move (x, y, z per vertex) pressing it to the skin. */
export type Tuck = { anchors: Record<string, Int32Array>; moves: Record<string, Float32Array>; keys: string[] };
/** Depth bias of outer garment layers (more negative draws in front). */
const OUTER_LAYERS: Record<string, number> = { top: -2, hat: -2, shoes: -1 };
type Entry = { spec: Wearable; group: Group; source: GLTF; skeletons: Set<Skeleton>; touched: number; keys: Map<SkinnedMesh, string>; pivot: Vector3; rest: Map<SkinnedMesh, RestGeometry>; originalGeometries: Set<BufferGeometry>; editProblem?: string };
type RestBone = { bone: Bone; matrix: Matrix4; parent: string | null };
/** Why a worn part keeps its own size and place (`canEdit` is false): its file cannot be resized in the browser. */
export const PART_FIXED = '이 파츠는 크기와 위치를 바꿀 수 없어요.';

function standardSlot(object: Object3D): unknown {
  // A glTF node with several material primitives loads as a Group. Its extras
  // belong to that parent, while the skinned primitive meshes are children.
  for (let node: Object3D | null = object; node; node = node.parent) {
    if (node.userData.standard_slot !== undefined) return node.userData.standard_slot;
  }
  return undefined;
}

function disposeEntry(entry: Entry) {
  entry.group.removeFromParent();
  const roots = [entry.group, ...entry.source.scenes], owned = new Set<BufferGeometry>();
  for (const root of roots) root.traverse(object => { if ((object as SkinnedMesh).isMesh) owned.add((object as SkinnedMesh).geometry); });
  disposeObjectResources(roots, entry.skeletons);
  for (const geometry of entry.originalGeometries) if (!owned.has(geometry)) geometry.dispose();
}

/** Variant meshes share the loaded body's actual bone objects and mixer.
 * Source bytes, bone order, bind matrices, UVs and weights stay intact. Edits change owned rest geometry buffers.
 */
export class NativeWardrobe {
  private bones = new Map<string, RestBone>();
  private baseMeshes: SkinnedMesh[] = [];
  private baseMaterials = new Map<Material, boolean>();
  private baseInverse: Matrix4;
  private active = new Map<string, Entry>();
  private loaded = new Map<string, Entry>();
  private loading = new Map<string, Promise<Entry>>();
  private references = new Map<string, number>();
  private generation = 0;
  private disposed = false;
  private lifetime = new AbortController();
  private hairColor: string | null = null;
  private hairControls = new Map<MeshStandardMaterial, (color: string | null) => void>();

  setHairColor(color: string | null) {
    if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('올바른 헤어 색상을 골라 주세요.');
    this.hairColor = color;
    this.hairControls.forEach(update => update(color));
  }

  private originalIndex = new Map<SkinnedMesh, BufferAttribute | null>();
  private partPositions = new WeakMap<SkinnedMesh, Float32Array>();
  private tuckedPositions = new WeakMap<SkinnedMesh, Float32Array>();
  private edits = new Map<string, PartEdit>();
  private regionControls = new Map<Material, { mask: Texture; update: (colors: (string | null)[]) => void }>();

  /** Region colours of the part worn in a slot; null entries keep the original colour.
   * index: the glTF material whose UV layout the mask follows. The mask stays the caller's: it disposes it once its part
   * is no longer worn, and a different mask for the same material replaces the one used before. */
  setRegionColors(slot: string, index: number, mask: Texture, lights: number[], colors: (string | null)[]) {
    const entry = this.active.get(slot);
    if (!entry) return;
    const materials = new Set<Material>();
    entry.group.traverse(object => {
      const mesh = object as SkinnedMesh;
      if (mesh.isSkinnedMesh) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => materials.add(material));
    });
    materials.forEach(material => {
      const association = entry.source.parser.associations.get(material) as { materials?: number } | undefined;
      if (!(material instanceof MeshStandardMaterial) || association?.materials !== index) return;
      let control = this.regionControls.get(material);
      if (!control) material.addEventListener('dispose', () => this.regionControls.delete(material));
      if (!control || control.mask !== mask) {
        control = { mask, update: regionColorControl(material, mask, lights) };
        this.regionControls.set(material, control);
      }
      control.update(colors);
    });
  }

  /** Hide body triangles under the worn garments: {"mesh:primitive": bitset (bit t = triangle t)}. */
  hideTriangles(hidden: Record<string, Uint8Array> | null) {
    for (const mesh of this.baseMeshes) {
      const geometry = mesh.geometry;
      if (!this.originalIndex.has(mesh)) this.originalIndex.set(mesh, geometry.index);
      const original = this.originalIndex.get(mesh)!;
      const key = this.primitiveKeys.get(mesh);
      const bits = key && hidden ? hidden[key] : undefined, position = geometry.attributes.position;
      if (!bits || !position || geometry.groups.length > 1) { if (geometry.index !== original) geometry.setIndex(original); continue; }
      const count = original ? original.count/3 : position.count/3;
      const kept: number[] = [];
      for (let t = 0; t < count; t++) {
        if (((bits[t >> 3] ?? 0) >> (t & 7)) & 1) continue;
        if (original) kept.push(original.getX(3*t), original.getX(3*t+1), original.getX(3*t+2));
        else kept.push(3*t, 3*t+1, 3*t+2);
      }
      const large = position.count > 65535;
      geometry.setIndex(new BufferAttribute(large ? new Uint32Array(kept) : new Uint16Array(kept), 1));
    }
  }

  /** Press a worn inner garment onto the skin where the outer garments worn with it cover the body
   * (outer: their hidden body triangles), so a waistband never shows through a top. */
  tuckUnder(slot: string, tuck: Tuck | null, outer: Record<string, Uint8Array> | null) {
    const entry = this.active.get(slot);
    if (!entry) return;
    // Body vertices under the outer garments: the corners of their hidden body triangles, grown by
    // one ring so the press reaches just past the outer garment's hem.
    const covered = new Map<string, Uint8Array>();
    if (tuck && outer) for (const mesh of this.baseMeshes) {
      const key = this.primitiveKeys.get(mesh), bits = key ? outer[key] : undefined, position = mesh.geometry.attributes.position;
      if (!key || !bits || !position) continue;
      const index = this.originalIndex.has(mesh) ? this.originalIndex.get(mesh)! : mesh.geometry.index;
      const corner = (t: number, k: number) => index ? index.getX(3*t+k) : 3*t+k;
      const vertices = new Uint8Array(position.count);
      const count = index ? index.count/3 : vertices.length/3;
      for (let t = 0; t < count; t++) {
        if (((bits[t >> 3] ?? 0) >> (t & 7)) & 1) for (let k = 0; k < 3; k++) vertices[corner(t, k)] = 1;
      }
      const grown = vertices.slice();
      for (let t = 0; t < count; t++) {
        if ((vertices[corner(t, 0)] ?? 0) | (vertices[corner(t, 1)] ?? 0) | (vertices[corner(t, 2)] ?? 0)) for (let k = 0; k < 3; k++) grown[corner(t, k)] = 1;
      }
      covered.set(key, grown);
    }
    entry.group.traverse(object => {
      const mesh = object as SkinnedMesh;
      const position = mesh.isSkinnedMesh ? mesh.geometry.attributes.position : undefined;
      if (!(position instanceof BufferAttribute) || !(position.array instanceof Float32Array) || position.itemSize !== 3) return;
      if (!this.partPositions.has(mesh)) this.partPositions.set(mesh, position.array.slice());
      const original = this.partPositions.get(mesh)!;
      const key = entry.keys.get(mesh);
      const anchor = key && tuck ? tuck.anchors[key] : undefined, move = key && tuck ? tuck.moves[key] : undefined;
      const values = original.slice();
      if (anchor && move && covered.size && anchor.length === position.count && move.length === 3*position.count) {
        for (let v = 0; v < position.count; v++) {
          const value = anchor[v] ?? -1, bodyKey = tuck!.keys[value >>> 20];
          if (value < 0 || !bodyKey || covered.get(bodyKey)?.[value & 0xfffff] !== 1) continue;
          for (let k = 0; k < 3; k++) values[3*v+k] = (values[3*v+k] ?? 0) + (move[3*v+k] ?? 0);
        }
      }
      this.tuckedPositions.set(mesh, values);
      position.array.set(values); position.needsUpdate = true;
    });
    this.applyEdit(entry);
  }

  setPartEdit(slot: string, edit: PartEdit | null) {
    if (!(EDITABLE_PARTS as readonly string[]).includes(slot) || (edit && !validPartEdit(edit))) throw new Error('파츠 크기와 위치 범위를 확인해 주세요.');
    const entry = this.active.get(slot);
    if (entry?.editProblem && edit && !isDefaultPartEdit(edit)) throw new Error(entry.editProblem);
    if (edit) this.edits.set(slot, { scale: [...edit.scale], translation: [...edit.translation] }); else this.edits.delete(slot);
    if (entry) this.applyEdit(entry);
    this.updateBodyVisibility();
  }

  /** Whether the part worn in `slot` may be resized and moved: an editable slot, and a file the browser can reshape. */
  canEdit(slot: string) {
    const entry = this.active.get(slot);
    return !!entry && (EDITABLE_PARTS as readonly string[]).includes(slot) && !entry.editProblem;
  }

  private updateBodyVisibility() {
    this.baseMaterials.forEach((visible, material) => {
      const value: unknown = material.userData.hidden_by_slots;
      const slots = typeof value === 'string' ? value.split('+') : Array.isArray(value) ? value : [];
      // Source material coverage cannot hide skin after its covering part has moved or changed size.
      material.visible = visible && !slots.some(slot => slot !== 'hair' && slot !== 'head'
        && slot !== 'hairFront' && slot !== 'hairBack' && this.active.has(slot)
        && (!this.edits.has(slot) || isDefaultPartEdit(this.edits.get(slot)!)));
    });
  }

  private applyEdit(entry: Entry) {
    if (!(EDITABLE_PARTS as readonly string[]).includes(entry.spec.slot)) return;
    const edit = this.edits.get(entry.spec.slot) || defaultPartEdit(), common = partEditMatrix(entry.pivot, edit);
    for (const [mesh, rest] of entry.rest) {
      const local = isDefaultPartEdit(edit) ? new Matrix4() : mesh.matrix.clone().invert().multiply(common).multiply(mesh.matrix);
      editGeometry(mesh.geometry, rest, this.tuckedPositions.get(mesh) || rest.position, local);
    }
  }

  constructor(private body: Object3D, private primitiveKeys: Map<Object3D, string> = new Map()) {
    body.updateMatrixWorld(true); this.baseInverse = body.matrixWorld.clone().invert();
    const rigs = new Set<Skeleton>();
    body.traverse(object => {
      const mesh = object as SkinnedMesh;
      if (mesh.isSkinnedMesh) {
        rigs.add(mesh.skeleton); this.baseMeshes.push(mesh);
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          this.baseMaterials.set(material, material.visible);
        }
      }
    });
    for (const rig of rigs) for (const bone of rig.bones) {
      const prior = this.bones.get(bone.name);
      if (!bone.name || (prior && prior.bone !== bone)) throw new Error('기준 몸의 본 이름이 중복되어 의상을 연결할 수 없어요.');
      this.bones.set(bone.name, { bone, matrix: this.baseInverse.clone().multiply(bone.matrixWorld), parent: (bone.parent as Bone)?.isBone ? bone.parent!.name : null });
    }
    if (!this.bones.size) throw new Error('기준 몸의 공용 골격이 없어요.');
  }

  private async load(spec: Wearable): Promise<Entry> {
    const cached = this.loaded.get(spec.id);
    if (cached) {
      if (cached.spec.sha256 !== spec.sha256 || cached.spec.slot !== spec.slot || cached.spec.url !== spec.url) throw new Error('같은 의상의 파일 버전이 바뀌었어요.');
      cached.touched = performance.now(); return cached;
    }
    const pending = this.loading.get(spec.id);
    if (pending) {
      const entry = await pending;
      if (entry.spec.sha256 !== spec.sha256 || entry.spec.slot !== spec.slot || entry.spec.url !== spec.url) throw new Error('동시에 고른 의상 버전이 달라요.');
      return entry;
    }
    const request = (async () => {
      let bytes: ArrayBuffer;
      try { bytes = await downloadBytes(spec.url, { signal: this.lifetime.signal, refused: '의상 모델을 불러올 수 없어요.' }); }
      catch (error) { throw loadFailure(error, '의상 모델'); }
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
      if (digest !== spec.sha256) throw new Error('의상 파일이 검수한 버전과 달라요.');
      const source = await new GLTFLoader().parseAsync(bytes, '');
      matteCharacter(source.scene);
      const entry: Entry = { spec, source, group: new Group(), skeletons: new Set(), touched: performance.now(), keys: new Map(), pivot: new Vector3(), rest: new Map(), originalGeometries: new Set() };
      try {
        if (this.disposed) throw new Error('옷장 화면이 닫혔어요.');
        source.scene.updateMatrixWorld(true);
        const meshes: SkinnedMesh[] = [];
        source.scene.traverse(object => { if ((object as SkinnedMesh).isSkinnedMesh) meshes.push(object as SkinnedMesh); });
        if (!meshes.length || meshes.some(mesh => standardSlot(mesh) !== spec.slot)) throw new Error('공용 골격에 맞춘 해당 슬롯의 의상 파일이 필요해요.');
        for (const mesh of meshes) {
          // "mesh:primitive", matching the server's layering anchors (the typings omit primitives).
          const mapping = source.parser.associations.get(mesh) as { meshes?: number; primitives?: number } | undefined;
          if (mapping?.meshes !== undefined && mapping.primitives !== undefined) entry.keys.set(mesh, `${mapping.meshes}:${mapping.primitives}`);
        }
        if (['hair', 'hairFront', 'hairBack'].includes(spec.slot)) {
          const materials = new Set(meshes.flatMap(mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
          materials.forEach(material => {
            if (!(material instanceof MeshStandardMaterial)) return;
            const update = hairColorControl(material); this.hairControls.set(material, update); update(this.hairColor);
            material.addEventListener('dispose', () => this.hairControls.delete(material));
          });
        }
        const offset = OUTER_LAYERS[spec.slot];
        if (offset !== undefined) {
          // Parts fitted in different jobs can touch within millimetres; the outer
          // layer (top over bottom, hat over hair) wins the depth test there.
          new Set(meshes.flatMap(mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material])).forEach(material => {
            Object.assign(material, { polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset*4 });
          });
        }
        for (const mesh of meshes) {
          const native = mesh.skeleton;
          if (native.bones.length !== this.bones.size) throw new Error('의상의 골격 규격이 기준 몸과 달라요.');
          const names = new Set<string>();
          const targets = native.bones.map(bone => {
            const rest = this.bones.get(bone.name);
            const parent = (bone.parent as Bone)?.isBone ? bone.parent!.name : null;
            if (!rest || names.has(bone.name) || rest.parent !== parent ||
                rest.matrix.elements.some((v, i) => Math.abs(v - (bone.matrixWorld.elements[i] ?? 0)) > 1e-4)) {
              throw new Error('의상의 본 위치·구조가 고정 몸과 맞지 않아요.');
            }
            names.add(bone.name); return rest.bone;
          });
          const transform = this.baseInverse.clone().multiply(mesh.matrixWorld);
          entry.skeletons.add(native);
          // Keep this mesh's bind matrices and bone index order. Only substitute
          // the verified equal-rest-pose bone objects, never recompute inverse binds.
          mesh.skeleton = new Skeleton(targets, native.boneInverses.map(matrix => matrix.clone()));
          entry.skeletons.add(mesh.skeleton);
          mesh.removeFromParent(); transform.decompose(mesh.position, mesh.quaternion, mesh.scale);
          // A nonuniformly scaled parent and rotated child can produce shear; keep the full affine matrix for bake parity.
          mesh.matrixAutoUpdate = false; mesh.matrix.copy(transform);
          mesh.name = `wardrobe-${spec.id}-${entry.group.children.length}`;
          mesh.userData.standard_slot = spec.slot;
          mesh.userData.wardrobePartId = spec.id; entry.group.add(mesh);
          if ((EDITABLE_PARTS as readonly string[]).includes(spec.slot)) {
            // Each loaded primitive needs its own buffers: glTF instances can share one geometry.
            entry.originalGeometries.add(mesh.geometry); mesh.geometry = mesh.geometry.clone(); const rest = restGeometry(mesh.geometry);
            // Quantized or interleaved positions are worn as they are; reshaping them would break the part.
            if (!rest) { entry.editProblem = PART_FIXED; continue; }
            // Resizing would leave its expression shapes (morph targets) behind.
            if (Object.values(mesh.geometry.morphAttributes).some(attributes => attributes.length)) entry.editProblem = PART_FIXED;
            entry.rest.set(mesh, rest); this.partPositions.set(mesh, rest.position);
          }
        }
        const bounds = new Box3(), point = new Vector3();
        const matrices = new Map<number, Matrix4>();
        for (const mesh of entry.rest.keys()) {
          const matrix = mesh.matrix, values = matrix.elements;
          if (values.some(value => !Number.isFinite(value)) || Math.abs(matrix.determinant()) < 1e-12 || [values[3]!, values[7]!, values[11]!, values[15]! - 1].some(value => Math.abs(value) > 1e-8)) entry.editProblem = PART_FIXED;
          const association = source.parser.associations.get(mesh) as { meshes?: number } | undefined;
          if (association?.meshes === undefined) continue;
          const previous = matrices.get(association.meshes);
          // One mesh placed in several spots cannot be resized about each spot's own centre.
          if (previous && !previous.equals(matrix)) entry.editProblem = PART_FIXED;
          matrices.set(association.meshes, matrix);
        }
        for (const [mesh, rest] of entry.rest) for (let index = 0; index < rest.position.length; index += 3) bounds.expandByPoint(point.fromArray(rest.position, index).applyMatrix4(mesh.matrix));
        if (!bounds.isEmpty()) bounds.getCenter(entry.pivot);
        this.loaded.set(spec.id, entry); return entry;
      } catch (error) { disposeEntry(entry); throw error; }
    })();
    this.loading.set(spec.id, request);
    try { return await request; } finally { this.loading.delete(spec.id); }
  }

  async equip(parts: Wearable[]): Promise<boolean> {
    if (this.disposed) throw new Error('옷장 화면이 닫혔어요.');
    if (new Set(parts.map(p => p.slot)).size !== parts.length || new Set(parts.map(p => p.id)).size !== parts.length) throw new Error('한 슬롯에는 의상 하나만 골라 주세요.');
    if (hasConflictingPartSlots(parts.map(part => part.slot))) throw new Error('전체 헤어와 앞·뒷머리 또는 기존 머리 파츠를 함께 입을 수 없어요.');
    const generation = ++this.generation;
    parts.forEach(part => this.references.set(part.id, (this.references.get(part.id) || 0)+1));
    try {
      const results = await Promise.allSettled(parts.map(part => this.load(part)));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      const entries = results.map(result => (result as PromiseFulfilledResult<Entry>).value);
      if (this.disposed || generation !== this.generation) return false;
      // Commit all slots together after every file passed. Failed loads retain
      // the previous outfit and the existing animation keeps advancing.
      for (const slot of this.edits.keys()) {
        const next = entries.find(entry => entry.spec.slot === slot);
        if (!next || this.active.get(slot)?.spec.id !== next.spec.id) this.edits.delete(slot);
      }
      this.active.forEach(entry => entry.group.removeFromParent());
      this.active = new Map(entries.map(entry => [entry.spec.slot, entry]));
      entries.forEach(entry => { entry.touched = performance.now(); this.body.add(entry.group); this.applyEdit(entry); });
      this.updateBodyVisibility();
      this.body.updateMatrixWorld(true); return true;
    } finally {
      parts.forEach(part => { const count = (this.references.get(part.id) || 1)-1; if (count) this.references.set(part.id, count); else this.references.delete(part.id); });
      this.prune();
    }
  }

  private prune() {
    const active = new Set(Array.from(this.active.values(), entry => entry.spec.id));
    const inactive = Array.from(this.loaded.values()).filter(entry => !active.has(entry.spec.id) && !this.references.has(entry.spec.id)).sort((a,b) => b.touched-a.touched);
    for (const entry of inactive.slice(2)) { this.loaded.delete(entry.spec.id); disposeEntry(entry); }
  }

  dispose() {
    this.disposed = true; this.generation++; this.lifetime.abort();
    this.baseMaterials.forEach((visible, material) => { material.visible = visible; }); this.baseMaterials.clear();
    this.originalIndex.forEach((index, mesh) => { if (mesh.geometry.index !== index) mesh.geometry.setIndex(index); }); this.originalIndex.clear();
    this.loaded.forEach(disposeEntry); this.loaded.clear(); this.active.clear();
  }
}
