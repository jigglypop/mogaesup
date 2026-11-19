import { act } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { TerrainPicker } from '../ui/TerrainPicker';

describe('칸 타일 고르기', () => {
  it('타일을 누르면 붓이 되고, 섬 전체는 그 붓으로 깔라고 한다', async () => {
    const onBrush = vi.fn();
    const onFill = vi.fn();
    const { container, unmount } = await mount(
      <TerrainPicker value="default" brush="snow" onBrush={onBrush} onFill={onFill} />,
    );
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.find((button) => button.textContent?.includes('눈밭'))?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { buttons.find((button) => button.textContent?.includes('이끼'))?.click(); });
    expect(onBrush).toHaveBeenCalledWith('moss');
    await act(async () => { buttons.find((button) => button.textContent === '섬 전체')?.click(); });
    expect(onFill).toHaveBeenCalledWith('snow');
    await unmount();
  });
});
