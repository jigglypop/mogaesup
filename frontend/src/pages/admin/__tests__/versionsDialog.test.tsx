import { act } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminCatalogItem, CatalogVersion } from '../../../api/types';
import { mount } from '../../../__tests__/mount';

const catalog = vi.hoisted(() => ({ versions: vi.fn(), rollback: vi.fn() }));
vi.mock('../../../api/endpoints', () => ({ catalogApi: catalog }));

import { VersionsDialog } from '../VersionsDialog';

const version = (id: number, current: boolean) =>
  ({ id, current, modelUrl: `/models/${id}.glb`, thumbnailUrl: null, clips: [], sourceRef: null, characterId: null, stage: null, report: null, importId: null, createdAt: '2026-10-01T00:00:00Z', createdBy: null }) as unknown as CatalogVersion;

afterEach(() => {
  vi.restoreAllMocks();
  catalog.versions.mockReset();
  catalog.rollback.mockReset();
});

describe('버전 되돌리기', () => {
  it('설명 없이 되돌릴지만 묻고, 그만두면 되돌리지 않는다', async () => {
    catalog.versions.mockResolvedValue({ versions: [version(2, true), version(1, false)] });
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const item = { id: 'item', label: '모개', emoji: '😊' } as unknown as AdminCatalogItem;
    const { unmount } = await mount(<VersionsDialog item={item} onClose={() => {}} onRolledBack={() => {}} onPreview={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    const back = [...document.querySelectorAll('button')].find((button) => button.textContent === '이 버전으로 되돌리기')!;
    await act(async () => back.click());
    expect(ask).toHaveBeenCalledExactlyOnceWith('모개을(를) 버전 #1(으)로 되돌릴까요?');
    expect(catalog.rollback).not.toHaveBeenCalled();
    await unmount();
  });
});
