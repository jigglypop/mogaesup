import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { CharacterFactory } from '../factory/CharacterFactory';
import { factoryApi } from '../factory/api';
import { api } from '../api';
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

/** Lets a picked photo be read (the browser reads its header from the file first) and prepared. */
const photoRead = () => act(async () => { for (let round = 0; round < 3; round++) await new Promise(resolve => setTimeout(resolve, 0)); });

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
      vi.unstubAllGlobals();
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

    it.each(['file', 'drop', 'paste'] as const)('%s 사진은 처리본을 확인한 뒤에만 업로드한다', async entry => {
      const source = new File(['original metadata'], 'photo.jpg', { type: 'image/jpeg' });
      const bitmap = { width: 6000, height: 4000, close: vi.fn() };
      vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo-preview');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      const draw = vi.fn();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['encoded pixels'], { type: 'image/jpeg' })));
      const create = vi.spyOn(api, 'create').mockResolvedValue({ id: 'new-photo', artifacts: [] } as never);
      const upload = vi.spyOn(api, 'upload').mockResolvedValue({} as never);
      const { container, unmount } = await mount(<CharacterFactory jobs={[]} jobsLoading={false} jobsError="" catalogError="" bodyProfileError="" onJob={() => {}} refreshJobs={async () => {}} />);
      const label = container.querySelector('label.character-upload')!, input = label.querySelector('input')!;
      await act(async () => {
        if (entry === 'paste') paste(label, [source]);
        else if (entry === 'drop') {
          const event = new Event('drop', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'dataTransfer', { value: { files: [source], types: ['Files'] } });
          label.dispatchEvent(event);
        } else {
          Object.defineProperty(input, 'files', { configurable: true, value: [source] });
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await photoRead();
      expect(container.querySelector('img[alt="업로드할 사진"]')).not.toBeNull();
      expect(container.textContent).toContain('2048 × 1365');
      expect(create).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
      expect(draw).toHaveBeenCalledWith(bitmap, 0, 0, 6000, 4000, 0, 0, 2048, 1365);
      await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '이 사진 사용')!.click());
      expect(create).toHaveBeenCalledExactlyOnceWith('photo', null);
      expect(upload).toHaveBeenCalledOnce();
      const prepared = upload.mock.calls[0]![1];
      expect(prepared).toBeInstanceOf(File); expect(prepared).not.toBe(source); expect(prepared.size).toBe(14);
      expect(container.querySelector('[aria-label="사진 자르기"]')).toBeNull();
      expect(bitmap.close).toHaveBeenCalledOnce();
      await unmount();
    });
    it('업로드만 실패하면 다시 눌러도 캐릭터를 새로 만들지 않고 만든 캐릭터에 올린다', async () => {
      const source = new File(['original'], 'photo.png', { type: 'image/png' });
      vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 400, height: 300, close: vi.fn() })));
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo-preview');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['encoded'], { type: 'image/png' })));
      const made = { id: 'made', revision: 'r1', artifacts: [] };
      const create = vi.spyOn(api, 'create').mockResolvedValue(made as never);
      const list = vi.spyOn(api, 'list').mockResolvedValue({ characters: [{ ...made, revision: 'r2' }] } as never);
      const upload = vi.spyOn(api, 'upload').mockRejectedValueOnce(new Error('업로드 실패')).mockResolvedValue({} as never);
      const { container, unmount } = await mount(<CharacterFactory jobs={[]} jobsLoading={false} jobsError="" catalogError="" bodyProfileError="" onJob={() => {}} refreshJobs={async () => {}} />);
      const input = container.querySelector<HTMLInputElement>('label.character-upload input')!;
      Object.defineProperty(input, 'files', { configurable: true, value: [source] });
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
      await photoRead();
      const use = () => [...container.querySelectorAll('button')].find(button => button.textContent === '이 사진 사용')!;
      await act(async () => use().click());
      expect(container.querySelector('[role=alert]')?.textContent).toBe('업로드 실패');
      await act(async () => use().click());
      expect(create).toHaveBeenCalledOnce();
      expect(list).toHaveBeenCalledOnce();
      expect(upload).toHaveBeenCalledTimes(2);
      expect(upload.mock.calls[1]![0]).toMatchObject({ id: 'made', revision: 'r2' });
      expect(container.querySelector('[aria-label="사진 자르기"]')).toBeNull();
      await unmount();
    });
  });
});
