import { describe, expect, it, vi } from 'vitest';

import { mount } from '../../../__tests__/mount';
import { BalloonPicker, BalloonShape } from '../BalloonPicker';
import { balloonElement } from '../dom';

describe('말풍선 고르기', () => {
  it('고르는 곳의 말풍선은 섬 위에 그리는 것과 같은 모양이다(움직이지만 않는다)', async () => {
    const view = await mount(<BalloonShape design="cloud" text="안녕" />);
    const drawn = balloonElement('안녕', 'cloud');
    drawn.classList.add('is-still');
    expect(view.container.innerHTML).toBe(drawn.outerHTML);
    await view.unmount();
  });

  it('지금 것을 표시하고, 모르는 값이면 기본을, 다른 것을 누르면 그 아이디를 알린다', async () => {
    const pick = vi.fn();
    const view = await mount(<BalloonPicker value="something-new" onPick={pick} />);
    const radios = [...view.container.querySelectorAll<HTMLButtonElement>('[role=radio]')];
    expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true').map((radio) => radio.querySelector('small')?.textContent)).toEqual(['기본']);
    radios.find((radio) => radio.querySelector('small')?.textContent === '도트')!.click();
    expect(pick).toHaveBeenCalledExactlyOnceWith('pixel');
    await view.unmount();
  });
});
