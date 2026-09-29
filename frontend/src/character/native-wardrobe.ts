import { BufferAttribute, Group, Matrix4, MeshStandardMaterial, Skeleton, Vector3, type Bone, type Object3D, type SkinnedMesh, type Material, type Texture } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { disposeObjectResources } from './assets/gpu-resources';
import { prepareExpressionMaterial } from './texture-expressions';
import { hairColorControl } from './hair-color';
import { regionColorControl } from './region-color';
import { matteCharacter } from './matte-materials';

export type Wearable = { id: string; slot: string; url: string; sha256: string };
/** An inner garment's tuck: per "mesh:primitive", the body vertex under each vertex (index into keys
 * << 20 | vertex, -1 for none) and the vertex-space move (x, y, z per vertex) pressing it to the skin. */
export type Tuck = { anchors: Record<string, Int32Array>; moves: Record<string, Float32Array>; keys: string[] };
/** Depth bias of outer garment layers (more negative draws in front). */
const OUTER_LAYERS: Record<string, number> = { top: -2, hat: -2, shoes: -1 };
type Entry = { spec: Wearable; group: Group; source: GLTF; skeletons: Set<Skeleton>; touched: number; keys: Map<SkinnedMesh, string> };
type RestBone = { bone: Bone; matrix: Matrix4; parent: string | null };

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
  disposeObjectResources([entry.group, ...entry.source.scenes], entry.skeletons);
}

/** Variant meshes share the loaded body's actual bone objects and mixer.
 * Source bytes, bone order, bind matrices, geometry, UVs and weights stay intact.
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
  private headGeneration = 0;
  private head?: Entry;
  private disposed = false;
  private lifetime = new AbortController();
  private hairColor: string | null = null;
  private hairControls = new Map<MeshStandardMaterial, (color: string | null) => void>();

  setHairColor(color: string | null) {
    if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('올바른 헤어 색상을 선택하세요.');
    this.hairColor = color;
    this.hairControls.forEach(update => update(color));
  }

  private originalIndex = new Map<SkinnedMesh, BufferAttribute | null>();
  private partPositions = new WeakMap<SkinnedMesh, Float32Array>();
  private regionControls = new Map<Material, { mask: Texture; update: (colors: (string | null)[]) => void }>();

  /** Region colours of the part worn in a slot; null entries keep the original colour.
   * index: the glTF material whose UV layout the mask follows. */
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
      if (!control || control.mask !== mask) {
        control = { mask, update: regionColorControl(material, mask, lights) };
        this.regionControls.set(material, control);
        material.addEventListener('dispose', () => this.regionControls.delete(material));
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
      const bits = key && hidden ? hidden[key] : undefined;
      if (!bits || geometry.groups.length > 1) { if (geometry.index !== original) geometry.setIndex(original); continue; }
      const count = original ? original.count/3 : geometry.attributes.position.count/3;
      const kept: number[] = [];
      for (let t = 0; t < count; t++) {
        if ((bits[t >> 3] >> (t & 7)) & 1) continue;
        if (original) kept.push(original.getX(3*t), original.getX(3*t+1), original.getX(3*t+2));
        else kept.push(3*t, 3*t+1, 3*t+2);
      }
      const large = geometry.attributes.position.count > 65535;
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
      const key = this.primitiveKeys.get(mesh), bits = key ? outer[key] : undefined;
      if (!key || !bits) continue;
      const index = this.originalIndex.has(mesh) ? this.originalIndex.get(mesh)! : mesh.geometry.index;
      const corner = (t: number, k: number) => index ? index.getX(3*t+k) : 3*t+k;
      const vertices = new Uint8Array(mesh.geometry.attributes.position.count);
      const count = index ? index.count/3 : vertices.length/3;
      for (let t = 0; t < count; t++) {
        if ((bits[t >> 3] >> (t & 7)) & 1) for (let k = 0; k < 3; k++) vertices[corner(t, k)] = 1;
      }
      const grown = vertices.slice();
      for (let t = 0; t < count; t++) {
        if (vertices[corner(t, 0)] | vertices[corner(t, 1)] | vertices[corner(t, 2)]) for (let k = 0; k < 3; k++) grown[corner(t, k)] = 1;
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
          const value = anchor[v];
          if (value < 0 || covered.get(tuck!.keys[value >>> 20])?.[value & 0xfffff] !== 1) continue;
          values[3*v] += move[3*v]; values[3*v+1] += move[3*v+1]; values[3*v+2] += move[3*v+2];
        }
      }
      position.array.set(values); position.needsUpdate = true;
    });
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
      if (!bone.name || (prior && prior.bone !== bone)) throw new Error('기준 몸의 본 이름이 중복되어 의상을 연결할 수 없습니다.');
      this.bones.set(bone.name, { bone, matrix: this.baseInverse.clone().multiply(bone.matrixWorld), parent: (bone.parent as Bone)?.isBone ? bone.parent!.name : null });
    }
    if (!this.bones.size) throw new Error('기준 몸의 공용 골격이 없습니다.');
  }

  private async load(spec: Wearable): Promise<Entry> {
    const cached = this.loaded.get(spec.id);
    if (cached) {
      if (cached.spec.sha256 !== spec.sha256 || cached.spec.slot !== spec.slot || cached.spec.url !== spec.url) throw new Error('같은 의상의 파일 버전이 변경되었습니다.');
      cached.touched = performance.now(); return cached;
    }
    const pending = this.loading.get(spec.id);
    if (pending) {
      const entry = await pending;
      if (entry.spec.sha256 !== spec.sha256 || entry.spec.slot !== spec.slot || entry.spec.url !== spec.url) throw new Error('동시에 선택한 의상 버전이 다릅니다.');
      return entry;
    }
    const request = (async () => {
      const response = await fetch(spec.url, { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(20000)]) });
      if (!response.ok) throw new Error('의상 모델을 불러올 수 없습니다.');
      const bytes = await response.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
      if (digest !== spec.sha256) throw new Error('의상 파일이 검수한 버전과 다릅니다.');
      const source = await new GLTFLoader().parseAsync(bytes, '');
      matteCharacter(source.scene);
      const entry: Entry = { spec, source, group: new Group(), skeletons: new Set(), touched: performance.now(), keys: new Map() };
      try {
        if (this.disposed) throw new Error('옷장 화면이 닫혔습니다.');
        source.scene.updateMatrixWorld(true);
        const meshes: SkinnedMesh[] = [];
        source.scene.traverse(object => { if ((object as SkinnedMesh).isSkinnedMesh) meshes.push(object as SkinnedMesh); });
        if (!meshes.length || meshes.some(mesh => standardSlot(mesh) !== spec.slot)) throw new Error('공용 골격에 맞춘 해당 슬롯의 의상 파일이 필요합니다.');
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
        if (spec.slot === 'faceHead') {
          const materials = new Set(meshes.flatMap(mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
          materials.forEach(material => { if (material instanceof MeshStandardMaterial) prepareExpressionMaterial(material); });
        }
        if (spec.slot in OUTER_LAYERS) {
          // Parts fitted in different jobs can touch within millimetres; the outer
          // layer (top over bottom, hat over hair) wins the depth test there.
          const offset = OUTER_LAYERS[spec.slot];
          new Set(meshes.flatMap(mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material])).forEach(material => {
            Object.assign(material, { polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset*4 });
          });
        }
        for (const mesh of meshes) {
          const native = mesh.skeleton;
          if (native.bones.length !== this.bones.size) throw new Error('의상의 골격 규격이 기준 몸과 다릅니다.');
          const names = new Set<string>();
          const targets = native.bones.map(bone => {
            const rest = this.bones.get(bone.name);
            const parent = (bone.parent as Bone)?.isBone ? bone.parent!.name : null;
            if (!rest || names.has(bone.name) || rest.parent !== parent ||
                rest.matrix.elements.some((v, i) => Math.abs(v - bone.matrixWorld.elements[i]) > 1e-4)) {
              throw new Error('의상의 본 위치·구조가 고정 몸과 맞지 않습니다. 다시 피팅해야 합니다.');
            }
            names.add(bone.name); return rest.bone;
          });
          const transform = this.baseInverse.clone().multiply(mesh.matrixWorld);
          entry.skeletons.add(native);
          // Keep this mesh's bind matrices and bone index order. Only substitute
          // the verified equal-rest-pose bone objects, never recompute inverse binds.
          mesh.skeleton = new Skeleton(targets, native.boneInverses.map(matrix => matrix.clone()));
          entry.skeletons.add(mesh.skeleton);
          mesh.removeFromParent(); transform.decompose(mesh.position, mesh.quaternion, mesh.scale); mesh.updateMatrix();
          mesh.name = `wardrobe-${spec.id}-${entry.group.children.length}`;
          mesh.userData.standard_slot = spec.slot;
          mesh.userData.wardrobePartId = spec.id; entry.group.add(mesh);
        }
        this.loaded.set(spec.id, entry); return entry;
      } catch (error) { disposeEntry(entry); throw error; }
    })();
    this.loading.set(spec.id, request);
    try { return await request; } finally { this.loading.delete(spec.id); }
  }

  async equip(parts: Wearable[]): Promise<boolean> {
    if (this.disposed) throw new Error('옷장 화면이 닫혔습니다.');
    if (new Set(parts.map(p => p.slot)).size !== parts.length || new Set(parts.map(p => p.id)).size !== parts.length) throw new Error('한 슬롯에는 의상 하나만 선택하세요.');
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
      this.active.forEach(entry => entry.group.removeFromParent());
      this.active = new Map(entries.map(entry => [entry.spec.slot, entry]));
      entries.forEach(entry => { entry.touched = performance.now(); this.body.add(entry.group); });
      this.baseMaterials.forEach((visible, material) => {
        const value: unknown = material.userData.hidden_by_slots;
        const slots = typeof value === 'string' ? value.split('+') : Array.isArray(value) ? value : [];
        // Older assemblies tagged the whole upper scalp as covered by hair.
        // A hairstyle is open between strands; hiding skin creates rear holes.
        material.visible = visible && !slots.some(slot => slot !== 'hair' && slot !== 'head'
          && slot !== 'hairFront' && slot !== 'hairBack' && this.active.has(slot));
      });
      this.body.updateMatrixWorld(true); return true;
    } finally {
      parts.forEach(part => { const count = (this.references.get(part.id) || 1)-1; if (count) this.references.set(part.id, count); else this.references.delete(part.id); });
      this.prune();
    }
  }

  async equipHead(spec: Wearable): Promise<boolean> {
    if (this.disposed) throw new Error('캐릭터 화면이 닫혔습니다.');
    if (spec.slot !== 'faceHead') throw new Error('분리된 머리 파츠가 필요합니다.');
    const generation = ++this.headGeneration;
    this.references.set(spec.id, (this.references.get(spec.id) || 0)+1);
    try {
      const entry = await this.load(spec);
      if (this.disposed || generation !== this.headGeneration) return false;
      this.head?.group.removeFromParent();
      this.head = entry;
      entry.touched = performance.now();
      this.body.add(entry.group);
      this.body.updateMatrixWorld(true);
      return true;
    } finally {
      const count = (this.references.get(spec.id) || 1)-1;
      if (count) this.references.set(spec.id, count); else this.references.delete(spec.id);
      this.prune();
    }
  }

  private prune() {
    const active = new Set(Array.from(this.active.values(), entry => entry.spec.id));
    if (this.head) active.add(this.head.spec.id);
    const inactive = Array.from(this.loaded.values()).filter(entry => !active.has(entry.spec.id) && !this.references.has(entry.spec.id)).sort((a,b) => b.touched-a.touched);
    for (const entry of inactive.slice(2)) { this.loaded.delete(entry.spec.id); disposeEntry(entry); }
  }

  diagnostics() {
    const sample: number[] = [], bodySample: number[] = [], partSamples: Record<string, number[]> = {}; let shared = true;
    this.body.updateMatrixWorld(true);
    for (const mesh of this.baseMeshes) {
      mesh.skeleton.update();
      const count = mesh.geometry.attributes.position.count;
      for (let i = 0; i < count; i += Math.max(1, Math.floor(count/8))) {
        const point = new Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i);
        mesh.applyBoneTransform(i, point).applyMatrix4(mesh.matrixWorld); bodySample.push(point.x, point.y, point.z);
      }
    }
    [...this.active.values(), ...(this.head ? [this.head] : [])].forEach(entry => { const points: number[] = []; partSamples[entry.spec.slot] = points; entry.group.traverse(object => {
      const mesh = object as SkinnedMesh; if (!mesh.isSkinnedMesh) return;
      shared &&= mesh.skeleton.bones.every(bone => this.bones.get(bone.name)?.bone === bone);
      mesh.skeleton.update();
      const count = mesh.geometry.attributes.position.count;
      for (let i = 0; i < count; i += Math.max(1, Math.floor(count/8))) {
        const point = new Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i);
        mesh.applyBoneTransform(i, point).applyMatrix4(mesh.matrixWorld); sample.push(point.x, point.y, point.z); points.push(point.x, point.y, point.z);
      }
    }); });
    return { partIds: Array.from(this.active.values(), entry => entry.spec.id), boneCount: this.bones.size, shared, sample, bodySample, partSamples };
  }

  dispose() {
    this.disposed = true; this.generation++; this.headGeneration++; this.lifetime.abort();
    this.baseMaterials.forEach((visible, material) => { material.visible = visible; }); this.baseMaterials.clear();
    this.originalIndex.forEach((index, mesh) => { if (mesh.geometry.index !== index) mesh.geometry.setIndex(index); }); this.originalIndex.clear();
    this.loaded.forEach(disposeEntry); this.loaded.clear(); this.active.clear(); this.head = undefined;
  }
}
