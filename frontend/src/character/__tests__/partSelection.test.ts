import { describe, expect, it } from 'vitest';
import { compatiblePartSlots, hasConflictingPartSlots, selectPartSlot } from '../factory/parts';
import { Bone, BufferGeometry, Group, MeshStandardMaterial, Skeleton, SkinnedMesh } from 'three';
import { NativeWardrobe } from '../native-wardrobe';

describe('머리 파츠 조합', () => {
  it('전체 헤어로 바꾸면 분리 헤어와 기존 머리를 벗기고 장식은 유지한다', () => {
    expect(selectPartSlot(['hairFront', 'hairBack', 'head', 'hat', 'top'], 'hair')).toEqual(['hat', 'top', 'hair']);
  });
  it('분리 헤어로 바꾸면 전체 헤어를 벗기고 앞뒤 조합을 허용한다', () => {
    expect(selectPartSlot(['hair', 'hairBack', 'hat'], 'hairFront')).toEqual(['hairBack', 'hat', 'hairFront']);
    expect(hasConflictingPartSlots(['body', 'hairFront', 'hairBack', 'hat'])).toBe(false);
  });
  it('기존 머리 교체는 모든 헤어와 장식을 벗긴다', () => {
    expect(selectPartSlot(['hair', 'hairFront', 'hairBack', 'hat', 'top'], 'head')).toEqual(['top', 'head']);
    expect(selectPartSlot(['head', 'top'], 'hat')).toEqual(['top', 'hat']);
  });
  it('겹친 저장 조합은 전체 헤어를 남기고 분리 헤어와 기존 머리를 제거한다', () => {
    expect(compatiblePartSlots(['body', 'head', 'hairFront', 'hairBack', 'hair', 'hat'])).toEqual(['body', 'hair', 'hat']);
    expect(hasConflictingPartSlots(['hair', 'hairBack'])).toBe(true);
    expect(compatiblePartSlots(['head', 'hairFront', 'hairBack'])).toEqual(['hairFront', 'hairBack']);
  });
  it('렌더러 경계도 중복 머리 요청을 모델 다운로드 전에 거절한다', async () => {
    const body = new Group(), head = new Bone(); head.name = 'Head'; body.add(head);
    const mesh = new SkinnedMesh(new BufferGeometry(), new MeshStandardMaterial()); mesh.bind(new Skeleton([head])); body.add(mesh);
    const wardrobe = new NativeWardrobe(body);
    try {
      await expect(wardrobe.equip(['hair', 'hairFront'].map(slot => ({ id: slot, slot, url: '/should-not-load.glb', sha256: 'unused' })))).rejects.toThrow('함께 입을 수 없어요');
      expect(body.children).toHaveLength(2);
    } finally { wardrobe.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); }
  });
});
