import { BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { defaultPartEdit, editGeometry, partEditMatrix, restGeometry, validPartEdit } from '../part-edit';

describe('공통 rest 좌표의 파츠 편집', () => {
  it('움직인 mesh local 좌표에서도 같은 중심을 기준으로 변형하고 반복 입력은 누적하지 않는다', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 2, 0, 0], 3));
    geometry.setAttribute('normal', new Float32BufferAttribute([1, 1, 0, 1, 1, 0], 3));
    const rest = restGeometry(geometry), mesh = new Matrix4().makeTranslation(10, 1, 0);
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
    expect(validPartEdit({ scale: [.79, 1, 1], translation: [0, 0, 0] })).toBe(false);
    expect(validPartEdit({ scale: [1, 1, 1], translation: [.051, 0, 0] })).toBe(false);
    expect(() => partEditMatrix(new Vector3(), { scale: [1, NaN, 1], translation: [0, 0, 0] })).toThrow('범위');
  });
});
