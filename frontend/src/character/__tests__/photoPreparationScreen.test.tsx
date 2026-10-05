import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { PhotoPreparation } from '../factory/PhotoPreparation';
import type { PhotoCrop } from '../photo-preparation';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('../photo-preparation', async (original) => ({
  ...(await original<typeof import('../photo-preparation')>()),
  decodePhoto: async () => ({ source: {}, width: 400, height: 300, close() {} }),
  preparePhoto: prepare,
}));

const slide = async (field: HTMLInputElement, value: number) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { set.call(field, String(value)); field.dispatchEvent(new Event('input', { bubbles: true })); });
};

describe('사진 자르기 화면', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:photo', revokeObjectURL: () => undefined }));
    prepare.mockImplementation(async (_photo: unknown, file: File, crop: PhotoCrop) => ({ file, width: Math.round(400 * crop.width), height: 300 }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); prepare.mockReset(); });

  it('슬라이더를 끄는 동안은 틀만 움직이고, 멈춘 뒤 한 번만 다시 만든다', async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const { container, unmount } = await mount(<PhotoPreparation file={file} busy={false} onUpload={async () => undefined} onCancel={() => undefined} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(prepare).toHaveBeenCalledOnce();
    const width = container.querySelector<HTMLInputElement>('input[aria-label="사진 자르기 너비"]')!;
    const use = () => [...container.querySelectorAll('button')].find((item) => item.textContent === '이 사진 사용')!;
    for (const value of [90, 80, 70, 60, 50]) await slide(width, value);
    expect(prepare).toHaveBeenCalledOnce();
    expect(use().disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1]![2]).toMatchObject({ width: 0.5 });
    expect(use().disabled).toBe(false);
    await unmount();
  });
});
