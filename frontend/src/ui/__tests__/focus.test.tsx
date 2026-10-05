import { act, useRef } from 'react';

import { describe, expect, it } from 'vitest';

import { mount } from '../../__tests__/mount';
import { focusables, useFocusTrap } from '../focus';

describe('포커스 트랩', () => {
  it('Tab이 닿는 것만 센다: tabindex=-1, 숨김, inert, 비활성은 빼고', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <button id="a">a</button>
      <button id="minus" tabindex="-1">minus</button>
      <a id="link" href="/x">link</a>
      <a id="nolink">nolink</a>
      <div hidden><button id="hidden">hidden</button></div>
      <div inert><button id="inert">inert</button></div>
      <fieldset disabled><button id="fieldset">fieldset</button></fieldset>
      <button id="off" disabled>off</button>
      <div id="custom" tabindex="0">custom</div>
      <span id="span" tabindex="-1">span</span>
    `;
    // (jsdom lists a selector group's matches by selector; browsers keep document order.)
    expect(focusables(root).map((element) => element.id).sort()).toEqual(['a', 'custom', 'link']);
  });

  it('대화상자 자신에 포커스가 있을 때 Shift+Tab은 마지막 컨트롤로 간다', async () => {
    function Dialog() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref);
      return (
        <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
          <button>first</button>
          <button>last</button>
        </div>
      );
    }
    const { container, unmount } = await mount(<Dialog />);
    const dialog = container.querySelector<HTMLElement>('[role=dialog]')!;
    const [, last] = [...dialog.querySelectorAll('button')];
    dialog.focus();
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(last);
    await unmount();
  });
});
