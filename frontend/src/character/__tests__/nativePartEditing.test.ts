import { Bone, BufferGeometry, Float32BufferAttribute, Group, Int16BufferAttribute, InterleavedBuffer, InterleavedBufferAttribute, Matrix4, MeshStandardMaterial, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeWardrobe } from '../native-wardrobe';
import type { PartEdit } from '../part-edit';

vi.mock('../assets/download', () => ({ downloadBytes: async () => new ArrayBuffer(0) }));
beforeEach(() => vi.stubGlobal('crypto', { subtle: { digest: async () => new Uint8Array(32).buffer } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(kind: 'plain' | 'morph' | 'shared' | 'quantized' | 'interleaved' = 'plain', slot = 'hat') {
  const geometry = new BufferGeometry();
  // KHR_mesh_quantization positions, and positions sharing one buffer with another attribute.
  geometry.setAttribute('position', kind === 'quantized' ? new Int16BufferAttribute([0, 0, 0, 2, 0, 0], 3)
    : kind === 'interleaved' ? new InterleavedBufferAttribute(new InterleavedBuffer(new Float32Array([0, 0, 0, 9, 2, 0, 0, 9]), 4), 3, 0)
      : new Float32BufferAttribute([0, 0, 0, 2, 0, 0], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute([2, 2, 0, 2, 2, 0], 3));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0], 4));
  const originalDispose = vi.spyOn(geometry, 'dispose');
  if (kind === 'morph') geometry.morphAttributes.position = [geometry.getAttribute('position').clone()];
  const body = new Group(), bone = new Bone(); bone.name = 'Root'; body.add(bone);
  const skin = new SkinnedMesh(geometry.clone(), new MeshStandardMaterial()); skin.geometry.setIndex([0, 1, 1]);
  skin.material.userData.hidden_by_slots = [slot]; skin.bind(new Skeleton([bone])); body.add(skin);
  const source = new Group(), sourceBone = new Bone(); sourceBone.name = 'Root'; source.add(sourceBone);
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial()); mesh.userData.standard_slot = slot;
  mesh.bind(new Skeleton([sourceBone]), new Matrix4());
  const parent = new Group(); parent.scale.set(2, 3, 1); parent.position.set(2, 3, 4); mesh.rotation.z = Math.PI / 4;
  parent.add(mesh); source.add(parent); source.updateMatrixWorld(true);
  const originalMatrix = mesh.matrixWorld.clone(), originalBind = mesh.bindMatrix.clone(), originalInverse = mesh.skeleton.boneInverses[0]!.clone();
  const associations = new Map<object, { meshes: number; primitives: number }>([[mesh, { meshes: 0, primitives: 0 }]]);
  if (kind === 'shared') {
    const instance = new SkinnedMesh(geometry, mesh.material); instance.userData.standard_slot = slot;
    instance.bind(mesh.skeleton, new Matrix4()); instance.position.x = 1; source.add(instance);
    associations.set(instance, { meshes: 0, primitives: 0 });
  }
  vi.spyOn(GLTFLoader.prototype, 'parseAsync').mockResolvedValue({ scene: source, scenes: [source], parser: { associations } } as unknown as GLTF);
  const wardrobe = new NativeWardrobe(body, new Map([[skin, '0:0']]));
  const equip = () => wardrobe.equip([{ id: `${slot}-v1`, slot, url: `/${slot}.glb`, sha256: '0'.repeat(64) }]);
  const dispose = () => { wardrobe.dispose(); skin.geometry.dispose(); skin.material.dispose(); skin.skeleton.dispose(); };
  return { wardrobe, mesh, geometry, originalDispose, originalMatrix, originalBind, originalInverse, bone, skin, equip, dispose };
}

describe('실제 옷장 파츠 변형', () => {
  it('affine shear와 bind를 유지하고 tuck 뒤 편집하며 크기 복구시 원래 피부 가림을 되돌린다', async () => {
    const value = fixture();
    try {
      await value.equip();
      expect(value.mesh.matrix.equals(value.originalMatrix)).toBe(true);
      expect(value.mesh.matrixAutoUpdate).toBe(false);
      expect(value.mesh.geometry).not.toBe(value.geometry);
      expect(value.mesh.skeleton.bones[0]).toBe(value.bone);
      expect(value.mesh.bindMatrix.equals(value.originalBind)).toBe(true);
      expect(value.mesh.skeleton.boneInverses[0]!.equals(value.originalInverse)).toBe(true);
      expect(value.skin.material.visible).toBe(false);
      const original = value.geometry.getAttribute('position'), before = [0, 1].map(index => new Vector3().fromBufferAttribute(original, index).applyMatrix4(value.originalMatrix));
      const pivot = before[0]!.clone().add(before[1]!).multiplyScalar(.5);
      value.wardrobe.tuckUnder('hat', { anchors: { '0:0': new Int32Array([0, 0]) }, moves: { '0:0': new Float32Array([0, 0, .02, 0, 0, .02]) }, keys: ['0:0'] }, { '0:0': new Uint8Array([1]) });
      const edit = { scale: [1.2, .8, 1] as [number, number, number], translation: [.05, -.02, 0] as [number, number, number] };
      value.wardrobe.setPartEdit('hat', edit);
      expect(value.skin.material.visible).toBe(true);
      for (const index of [0, 1]) {
        const tucked = new Vector3().fromBufferAttribute(original, index).add(new Vector3(0, 0, .02)).applyMatrix4(value.originalMatrix);
        const expected = tucked.sub(pivot).multiply(new Vector3(...edit.scale)).add(pivot).add(new Vector3(...edit.translation));
        const actual = new Vector3().fromBufferAttribute(value.mesh.geometry.getAttribute('position'), index).applyMatrix4(value.mesh.matrix);
        expect(actual.distanceTo(expected)).toBeLessThan(1e-6);
      }
      value.wardrobe.setPartEdit('hat', null);
      expect(value.skin.material.visible).toBe(false);
      expect([...value.mesh.geometry.getAttribute('normal').array]).toEqual([...value.geometry.getAttribute('normal').array]);
      expect([...value.mesh.geometry.getAttribute('skinWeight').array]).toEqual([...value.geometry.getAttribute('skinWeight').array]);
    } finally { value.dispose(); }
    expect(value.skin.material.visible).toBe(true);
    expect(value.originalDispose).toHaveBeenCalledOnce();
  });

  it.each(['top', 'bottom', 'shoes'])('%s도 bind를 유지한 채 rest geometry를 바꾸고, 바꾸는 동안 그 옷이 가리던 몸 재질을 보인다', async slot => {
    const value = fixture('plain', slot);
    try {
      await value.equip();
      expect(value.mesh.geometry).not.toBe(value.geometry);
      expect(value.skin.material.visible).toBe(false);
      const original = value.geometry.getAttribute('position'), before = [0, 1].map(index => new Vector3().fromBufferAttribute(original, index).applyMatrix4(value.originalMatrix));
      const pivot = before[0]!.clone().add(before[1]!).multiplyScalar(.5);
      const edit: PartEdit = { scale: [1, 1.5, .6], translation: [0, -.15, .1] };
      value.wardrobe.setPartEdit(slot, edit);
      expect(value.skin.material.visible).toBe(true);
      for (const index of [0, 1]) {
        const expected = before[index]!.clone().sub(pivot).multiply(new Vector3(...edit.scale)).add(pivot).add(new Vector3(...edit.translation));
        const actual = new Vector3().fromBufferAttribute(value.mesh.geometry.getAttribute('position'), index).applyMatrix4(value.mesh.matrix);
        expect(actual.distanceTo(expected)).toBeLessThan(1e-6);
      }
      expect(value.mesh.skeleton.bones[0]).toBe(value.bone);
      expect(value.mesh.bindMatrix.equals(value.originalBind)).toBe(true);
      expect(value.mesh.skeleton.boneInverses[0]!.equals(value.originalInverse)).toBe(true);
      expect([...value.mesh.geometry.getAttribute('skinWeight').array]).toEqual([...value.geometry.getAttribute('skinWeight').array]);
      value.wardrobe.setPartEdit(slot, null);
      expect(value.skin.material.visible).toBe(false);
      expect([...value.mesh.geometry.getAttribute('position').array]).toEqual([...original.array]);
    } finally { value.dispose(); }
  });

  it.each([['morph', 'hat'], ['shared', 'hat'], ['morph', 'bottom'], ['morph', 'shoes'], ['quantized', 'hat'], ['interleaved', 'top']] as const)('%s %s 파츠는 원래 착용을 허용하고 편집할 수 없다고 미리 알리며 nonidentity 편집을 거절한다', async (kind, slot) => {
    const value = fixture(kind, slot);
    try {
      await expect(value.equip()).resolves.toBe(true);
      expect(value.wardrobe.canEdit(slot)).toBe(false);
      expect(() => value.wardrobe.setPartEdit(slot, { scale: [1.1, 1, 1], translation: [0, 0, 0] })).toThrow('크기와 위치를 바꿀 수 없어요');
      expect(() => value.wardrobe.setPartEdit(slot, null)).not.toThrow();
      // Worn as it came: the file's own positions, untouched.
      const position = value.mesh.geometry.getAttribute('position');
      expect([position.getX(1), position.getY(1), position.getZ(1)]).toEqual([2, 0, 0]);
    } finally { value.dispose(); }
  });

  it('편집할 수 있는 파츠는 입은 뒤에 그렇다고 알린다', async () => {
    const value = fixture('plain', 'top');
    try {
      expect(value.wardrobe.canEdit('top')).toBe(false);
      await value.equip();
      expect(value.wardrobe.canEdit('top')).toBe(true);
      expect(value.wardrobe.canEdit('hat')).toBe(false);
    } finally { value.dispose(); }
  });

  it('고칠 수 없는 슬롯과 범위를 벗어난 값은 거절한다', async () => {
    const value = fixture('plain', 'weapon');
    try {
      await value.equip();
      expect(() => value.wardrobe.setPartEdit('weapon', { scale: [1.1, 1, 1], translation: [0, 0, 0] })).toThrow('범위');
    } finally { value.dispose(); }
    const hat = fixture();
    try {
      await hat.equip();
      expect(() => hat.wardrobe.setPartEdit('hat', { scale: [1, 1, 1], translation: [0, .151, 0] })).toThrow('범위');
      expect(() => hat.wardrobe.setPartEdit('hat', { scale: [1, 1.5, 1], translation: [0, .15, 0] })).not.toThrow();
    } finally { hat.dispose(); }
  });
});
