import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { CharacterFactory } from '../factory/CharacterFactory';
import { factoryApi } from '../factory/api';
import { GlbUpload } from '../studio/GlbUpload';

vi.mock('../use-live-characters', () => ({ useLiveCharacters: () => ({ characters: [], failure: '', loading: false, refresh: async () => {} }) }));
// The panels beside the photo input are not what is tested.
vi.mock('../factory/NativeAssembly', () => ({ NativeAssembly: () => null }));
vi.mock('../factory/StageRunner', () => ({ StageRunner: () => null }));
vi.mock('../factory/PartProgress', () => ({ PartProgress: () => null }));
vi.mock('../factory/ProductionProgress', () => ({ ProductionProgress: () => null }));
vi.mock('../factory/RigRecovery', () => ({ RigRecovery: () => null }));
vi.mock('../studio/MeshyOptionsEditor', () => ({ MeshyOptionsEditor: () => null }));

const focusable = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
/** A paste carrying `files`, the way the browser hands one to the focused element. */
const paste = (target: Element, files: File[]) => {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, types: ['Files'] } });
  target.dispatchEvent(event);
};

describe('파일을 고르는 곳', () => {
  it('GLB 등록은 파일 입력 하나만 키보드로 닿고, 그곳에 붙여넣어도 고른다', async () => {
    const { container, unmount } = await mount(<GlbUpload onUpload={async () => {}} />);
    const zone = container.querySelector('.glb-upload')!;
    expect(zone.hasAttribute('tabindex')).toBe(false);
    expect(zone.hasAttribute('aria-label')).toBe(false);
    const controls = [...zone.querySelectorAll(focusable)];
    expect(controls).toHaveLength(1);
    const input = controls[0] as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.closest('label')).not.toBeNull();
    await act(async () => paste(input, [new File([new Uint8Array([1])], 'hat.glb')]));
    expect(zone.textContent).toContain('hat.glb');
    expect([...zone.querySelectorAll('button')].map((item) => item.textContent)).toEqual(['등록']);
    await unmount();
  });

  describe('사진으로 전체 생성', () => {
    let previous: string;
    beforeEach(() => {
      previous = `${location.pathname}${location.search}`;
      history.replaceState(null, '', '/admin/studio/make/photo');
      vi.spyOn(factoryApi, 'capabilities').mockResolvedValue({ ready: true, image_provider: 'x', image_model: 'x', slots: [], meshy_model: 'x', image_configured: true, meshy_configured: true, blender_available: true, next_actions: [] });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      history.replaceState(null, '', previous);
    });

    it('사진 칸은 버튼 역할 없이 label 안의 파일 입력 하나로 키보드에서 닿는다', async () => {
      const { container, unmount } = await mount(<CharacterFactory jobs={[]} jobsLoading={false} jobsError="" catalogError="" bodyProfileError="" onJob={() => {}} refreshJobs={async () => {}} />);
      await act(async () => { await Promise.resolve(); });
      const label = container.querySelector('label.character-upload')!;
      expect(label.getAttribute('role')).toBeNull();
      expect(label.hasAttribute('tabindex')).toBe(false);
      const controls = [...label.querySelectorAll(focusable)];
      expect(controls).toHaveLength(1);
      expect(controls[0]?.getAttribute('aria-label')).toBe('캐릭터 사진');
      expect((controls[0] as HTMLInputElement).type).toBe('file');
      await unmount();
    });
  });
});
