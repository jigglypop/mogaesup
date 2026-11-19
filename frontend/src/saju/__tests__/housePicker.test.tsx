import { act } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { profileOf } from '../profile';
import { HousePicker } from '../ui/HousePicker';
import { personOf } from './people';

describe('집 고르기', () => {
  it('모양·지붕·장식 색을 고르면 그 집을 청하고, 사주의 집과 같아지면 사주대로 돌린다', async () => {
    const chart = profileOf(personOf('sol').birth).house;
    const onChoose = vi.fn();
    const { container, unmount } = await mount(<HousePicker chart={chart} chosen={null} onChoose={onChoose} />);
    const button = (text: string) => [...container.querySelectorAll('button')].find((one) => one.textContent?.includes(text));
    expect(button('숲속 오두막')?.getAttribute('aria-pressed')).toBe('true');
    expect(button('쌍박공')?.getAttribute('aria-pressed')).toBe('true');
    expect(button('사주대로 짓기')?.hasAttribute('disabled')).toBe(true);
    await act(async () => { button('붉은 벽돌집')?.click(); });
    expect(onChoose).toHaveBeenLastCalledWith({ style: 'fire', roof: 'gables', accent: 'fire' });
    await act(async () => { button('천문 돔')?.click(); });
    expect(onChoose).toHaveBeenLastCalledWith({ style: 'wood', roof: 'dome', accent: 'fire' });
    await unmount();

    const chosen = { style: 'fire', roof: 'gables', accent: 'fire' } as const;
    const again = await mount(<HousePicker chart={chart} chosen={chosen} onChoose={onChoose} />);
    const pressed = (text: string) => [...again.container.querySelectorAll('button')].find((one) => one.textContent?.includes(text));
    expect(pressed('붉은 벽돌집')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { pressed('숲속 오두막')?.click(); });
    expect(onChoose).toHaveBeenLastCalledWith(null);
    await act(async () => { pressed('사주대로 짓기')?.click(); });
    expect(onChoose).toHaveBeenLastCalledWith(null);
    await again.unmount();
  });
});
