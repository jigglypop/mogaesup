import { BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { defaultPartEdit, EDITABLE_PARTS, editGeometry, partEditMatrix, restGeometry, validPartEdit, type PartEdit } from '../part-edit';

describe('공통 rest 좌표의 파츠 편집', () => {
  it('움직인 mesh local 좌표에서도 같은 중심을 기준으로 변형하고 반복 입력은 누적하지 않는다', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 2, 0, 0], 3));
    geometry.setAttribute('normal', new Float32BufferAttribute([1, 1, 0, 1, 1, 0], 3));
    const rest = restGeometry(geometry)!, mesh = new Matrix4().makeTranslation(10, 1, 0);
    const common = partEditMatrix(new Vector3(11, 1, 0), { scale: [1.2, .8, 1], translation: [.05, 0, 0] });
    const local = mesh.clone().invert().multiply(common).multiply(mesh);
    editGeometry(geometry, rest, rest.position, local);
    const first = [...geometry.getAttribute('position').array];
    expect(first[0]).toBeCloseTo(-.15); expect(first[3]).toBeCloseTo(2.25);
    editGeometry(geometry, rest, rest.position, local);
    expect([...geometry.getAttribute('position').array]).toEqual(first);
    const normal = geometry.getAttribute('normal'); expect(normal.getY(0) / normal.getX(0)).toBeCloseTo(1.5);
    editGeometry(geometry, rest, rest.position, partEditMatrix(new Vector3(11, 1, 0), defaultPartEdit()));
    expect([...geometry.getAttribute('position').array]).toEqual([...rest.position]);
    expect([...geometry.getAttribute('normal').array]).toEqual([...rest.normal!]);
  });
  it('음수·비유한 값과 크기/위치 범위를 거절한다', () => {
    expect(validPartEdit(defaultPartEdit())).toBe(true);
    expect(validPartEdit({ scale: [.59, 1, 1], translation: [0, 0, 0] })).toBe(false);
    expect(validPartEdit({ scale: [1, 1, 1], translation: [.051, 0, 0] })).toBe(false);
    expect(() => partEditMatrix(new Vector3(), { scale: [1, NaN, 1], translation: [0, 0, 0] })).toThrow('범위');
  });
  it('크기는 축마다 60~150%, 위치는 상하 ±15cm·앞뒤 ±10cm·좌우 ±5cm까지 받고 예전 범위로 저장한 값도 받는다', () => {
    for (const edit of [
      { scale: [.6, 1.5, .6], translation: [.05, -.15, .1] },
      { scale: [1.5, .6, 1.5], translation: [-.05, .15, -.1] },
      // What the narrower sliders could save: 80~120%, ±5cm on every axis.
      { scale: [1.2, .8, 1.1], translation: [.05, -.05, .05] },
      { scale: [.8, 1.2, .8], translation: [-.05, .05, -.05] },
    ] satisfies PartEdit[]) expect(validPartEdit(edit), JSON.stringify(edit)).toBe(true);
    for (const edit of [
      { scale: [.59, 1, 1], translation: [0, 0, 0] },
      { scale: [1, 1.51, 1], translation: [0, 0, 0] },
      { scale: [1, 1, .59], translation: [0, 0, 0] },
      { scale: [1, 1, 1], translation: [-.051, 0, 0] },
      { scale: [1, 1, 1], translation: [0, .151, 0] },
      { scale: [1, 1, 1], translation: [0, 0, -.101] },
      { scale: [1, Infinity, 1], translation: [0, 0, 0] },
      { scale: [1, 1, 1], translation: [0, 0, NaN] },
    ] satisfies PartEdit[]) expect(validPartEdit(edit), JSON.stringify(edit)).toBe(false);
  });
  it('헤어·모자·안경과 상의·하의·신발을 옷장 순서대로 고칠 수 있다', () => {
    expect(EDITABLE_PARTS).toEqual(['hair', 'hairFront', 'hairBack', 'hat', 'top', 'bottom', 'shoes', 'glasses']);
  });
});
