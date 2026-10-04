import { act } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import type { HomeView } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { About } from '../Profile';
import { PictureError } from '../sharePicture';

const { fromFile, capture } = vi.hoisted(() => ({
  fromFile: vi.fn<(file: File) => Promise<string>>(),
  capture: vi.fn<(canvas: HTMLCanvasElement) => Promise<string>>(),
}));
vi.mock('../sharePicture', async (original) => ({
  ...(await original<typeof import('../sharePicture')>()),
  thumbnailFromFile: fromFile,
  captureIsland: capture,
}));

const view = (isOwner: boolean, thumbnailUrl: string | null = null): HomeView => ({
  isOwner,
  visits: { today: 0, total: 0 },
  profile: {
    ownerId: 'owner',
    username: 'mogae',
    ownerName: '모개',
    title: '모개숲',
    statusMessage: '',
    mood: 0,
    minime: 'man',
    emoji: '😊',
    visibility: 'public',
    updatedAt: '2026-10-04T00:00:00Z',
    thumbnailUrl,
  },
});
const PICTURE = 'data:image/jpeg;base64,AAAA';
const settle = () => act(async () => { for (let round = 0; round < 3; round++) await new Promise((done) => setTimeout(done, 0)); });
const buttons = (container: HTMLElement) => [...container.querySelectorAll('button')].map((button) => button.textContent?.trim());
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!;

describe('공유 사진', () => {
  afterEach(() => {
    fromFile.mockReset();
    capture.mockReset();
  });

  const open = (home: HomeView, onThumbnail?: (image: string | null) => Promise<void>, islandCanvas?: () => HTMLCanvasElement | null) =>
    mount(<About view={home} minimes={[]} look={null} onUpdate={() => {}} onWearLook={() => {}} onThumbnail={onThumbnail} islandCanvas={islandCanvas} />);

  it('섬 주인에게만 보인다', async () => {
    const save = vi.fn(async () => {});
    const visitor = await open(view(false), save, () => null);
    expect(visitor.container.textContent).not.toContain('공유 사진');
    expect(visitor.container.querySelector('input[type=file]')).toBeNull();
    await visitor.unmount();
    // The island page gives the saving only to its owner.
    const unsaved = await open(view(true));
    expect(unsaved.container.textContent).not.toContain('공유 사진');
    await unsaved.unmount();

    const owner = await open(view(true), save, () => null);
    expect(owner.container.textContent).toContain('공유 사진');
    expect(owner.container.querySelector<HTMLImageElement>('.mg-thumb img')?.getAttribute('src')).toBe('/share.jpg');
    expect(buttons(owner.container)).toEqual(expect.arrayContaining(['사진 고르기', '섬 화면으로']));
    // Nothing to go back from yet.
    expect(buttons(owner.container)).not.toContain('기본으로');
    await owner.unmount();
  });

  it('고른 사진을 미리보기 모양으로 만들어 저장하고, 기본으로 되돌린다', async () => {
    const save = vi.fn(async () => {});
    fromFile.mockResolvedValueOnce(PICTURE);
    const { container, rerender, unmount } = await open(view(true), save);
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toBe('image/png,image/jpeg');
    const file = new File(['photo'], 'island.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(fromFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(save).toHaveBeenCalledExactlyOnceWith(PICTURE);

    await rerender(<About view={view(true, `/models/${'a'.repeat(64)}.jpg`)} minimes={[]} look={null} onUpdate={() => {}} onWearLook={() => {}} onThumbnail={save} />);
    expect(container.querySelector<HTMLImageElement>('.mg-thumb img')?.getAttribute('src')).toBe(`/models/${'a'.repeat(64)}.jpg`);
    await act(async () => button(container, '기본으로').click());
    await settle();
    expect(save).toHaveBeenLastCalledWith(null);
    await unmount();
  });

  it('붙여 넣은 사진도 쓴다', async () => {
    const save = vi.fn(async () => {});
    fromFile.mockResolvedValueOnce(PICTURE);
    const { container, unmount } = await open(view(true), save);
    const file = new File(['shot'], 'shot.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } });
    await act(async () => { container.querySelector('.mg-thumb')!.dispatchEvent(paste); });
    await settle();
    expect(paste.defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledExactlyOnceWith(PICTURE);
    await unmount();
  });

  it('섬 화면으로는 지금 그린 섬 캔버스를 담아 저장한다', async () => {
    const save = vi.fn(async () => {});
    const canvas = document.createElement('canvas');
    capture.mockResolvedValueOnce(PICTURE);
    const { container, unmount } = await open(view(true), save, () => canvas);
    await act(async () => button(container, '섬 화면으로').click());
    await settle();
    expect(capture).toHaveBeenCalledExactlyOnceWith(canvas);
    expect(save).toHaveBeenCalledExactlyOnceWith(PICTURE);
    await unmount();
  });

  it('하는 동안 다른 버튼을 막고, 실패하면 이유를 보여 준다', async () => {
    let finish!: (url: string) => void;
    fromFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const save = vi.fn<(image: string | null) => Promise<void>>().mockRejectedValueOnce(new ApiRequestError(413, 'picture_too_large', '사진이 너무 커요.'));
    const canvas = document.createElement('canvas');
    const { container, unmount } = await open(view(true), save, () => canvas);
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { value: [new File(['p'], 'p.jpg', { type: 'image/jpeg' })], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(button(container, '올리는 중…').disabled).toBe(true);
    expect(button(container, '섬 화면으로').disabled).toBe(true);
    finish(PICTURE);
    await settle();
    expect(container.querySelector('[role=alert]')?.textContent).toBe('사진이 너무 커요.');
    expect(button(container, '사진 고르기').disabled).toBe(false);

    // Nothing drawn could be taken: said in words, nothing saved.
    capture.mockRejectedValueOnce(new PictureError('섬 화면을 담지 못했어요.'));
    await act(async () => button(container, '섬 화면으로').click());
    await settle();
    expect(capture).toHaveBeenCalledExactlyOnceWith(canvas);
    expect(container.querySelector('[role=alert]')?.textContent).toBe('섬 화면을 담지 못했어요.');
    expect(save).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
