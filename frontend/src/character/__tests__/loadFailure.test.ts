import { Bone, BufferGeometry, Group, Mesh, MeshStandardMaterial, Skeleton, SkinnedMesh, Texture } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadFailure } from '../assets/load-failure';
import { NativeWardrobe } from '../native-wardrobe';
import { TextureExpressions } from '../texture-expressions';

const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

describe('모델·이미지를 불러오다 실패한 이유', () => {
  it('시간이 초과되면 영어 DOMException 대신 한글로 알린다', () => {
    expect(loadFailure(timeout(), '모델 파일').message).toBe('모델 파일 불러오기 시간이 초과되었습니다.');
  });

  it('취소되면 취소되었다고 알린다', () => {
    expect(loadFailure(new DOMException('signal is aborted without reason', 'AbortError'), '의상 모델').message).toBe(
      '의상 모델 불러오기가 취소되었습니다.',
    );
  });

  it('AbortSignal.timeout이 만든 실패도 같다', async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((done) => setTimeout(done, 20));
    expect(loadFailure(signal.reason, '표정 텍스처').message).toBe('표정 텍스처 불러오기 시간이 초과되었습니다.');
  });

  it('다른 실패는 그대로 둔다', () => {
    const own = new Error('모델 파일을 불러올 수 없습니다.');
    expect(loadFailure(own, '모델 파일')).toBe(own);
    expect(loadFailure('boom', '모델 파일').message).toBe('boom');
    expect(loadFailure(null, '모델 파일')).toBeInstanceOf(Error);
  });
});

describe('시간 초과가 화면에 닿는 곳', () => {
  beforeEach(() => vi.stubGlobal('fetch', () => Promise.reject(timeout())));
  afterEach(() => vi.unstubAllGlobals());

  it('표정 텍스처 요청', async () => {
    const material = Object.assign(new MeshStandardMaterial(), { map: new Texture() });
    const scene = new Group().add(new Mesh(new BufferGeometry(), material));
    const gltf = { scene, parser: { associations: new Map([[material, { materials: 0 }]]) } } as unknown as GLTF;
    const expressions = new TextureExpressions(gltf);
    await expect(expressions.saved([{ material: 0, url: '/face.png', sha256: 'x' }])).rejects.toThrow(
      '표정 텍스처 불러오기 시간이 초과되었습니다.',
    );
    expressions.dispose();
  });

  it('의상 모델 요청', async () => {
    const root = new Bone();
    root.name = 'root';
    const mesh = new SkinnedMesh(new BufferGeometry(), new MeshStandardMaterial());
    mesh.add(root);
    mesh.bind(new Skeleton([root]));
    const wardrobe = new NativeWardrobe(new Group().add(mesh));
    await expect(wardrobe.equip([{ id: 'hat', slot: 'hat', url: '/hat.glb', sha256: 'x' }])).rejects.toThrow(
      '의상 모델 불러오기 시간이 초과되었습니다.',
    );
    wardrobe.dispose();
  });
});
