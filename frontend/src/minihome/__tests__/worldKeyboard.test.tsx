import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { WorldKeyboard } from '../WorldKeyboard';

vi.mock('gaesup-world', () => ({ useWorldLoadProgress: () => ({ stage: 'ready' }) }));

describe('아무것도 고르지 않았을 때 누른 이동 키', () => {
  let canvas: HTMLCanvasElement;
  /** What the world hears on its canvas, as [key, code]. */
  let heard: string[][];
  beforeEach(() => {
    const box = document.body.appendChild(document.createElement('div'));
    box.className = 'mg-world-canvas';
    canvas = box.appendChild(document.createElement('canvas'));
    canvas.tabIndex = 0;
    heard = [];
    canvas.addEventListener('keydown', (event) => heard.push([event.key, event.code]));
  });
  afterEach(() => document.body.replaceChildren());

  const press = (target: Element, key: string, code: string) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
    });
  /** The island is ready and takes the keyboard; then something that takes no focus is clicked, and the page has it. */
  const open = async () => {
    const view = await mount(<WorldKeyboard enabled />);
    expect(document.activeElement).toBe(canvas);
    canvas.blur();
    expect(document.activeElement).toBe(document.body);
    return view;
  };

  it('한글 입력 상태에서 W 자리를 누르면(ㅈ) 월드가 키보드를 받고 그 키를 같은 자리 그대로 듣는다', async () => {
    const { unmount } = await open();
    await press(document.body, 'ㅈ', 'KeyW');
    expect(document.activeElement).toBe(canvas);
    expect(heard).toEqual([['ㅈ', 'KeyW']]);
    // Jumping and the arrows go by their place too.
    for (const [key, code] of [[' ', 'Space'], ['ArrowUp', 'ArrowUp']]) {
      canvas.blur();
      await press(document.body, key!, code!);
      expect(document.activeElement).toBe(canvas);
    }
    expect(heard).toEqual([['ㅈ', 'KeyW'], [' ', 'Space'], ['ArrowUp', 'ArrowUp']]);
    await unmount();
  });

  it('이동 키 자리가 아니거나 입력 칸에서 친 키는 월드로 보내지 않는다', async () => {
    const { unmount } = await open();
    await press(document.body, 'q', 'KeyQ');
    // AZERTY's W is where QWERTY has Z, which the world does not walk with.
    await press(document.body, 'w', 'KeyZ');
    expect(document.activeElement).toBe(document.body);
    const field = document.body.appendChild(document.createElement('input'));
    field.focus();
    await press(field, 'w', 'KeyW');
    expect(document.activeElement).toBe(field);
    expect(heard).toEqual([]);
    await unmount();
  });
});
