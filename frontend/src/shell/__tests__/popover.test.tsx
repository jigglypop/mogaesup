import { act } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { nextMenuIndex, usePopover } from '../Shell';

vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));

function Menu() {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref}>
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        내 메뉴
      </button>
      {open && (
        <div className="mg-popover">
          <div role="menu">
            <button role="menuitem">내 섬</button>
            <button role="menuitemradio" aria-checked>
              밝게
            </button>
            <button role="menuitem" disabled>
              꺼진 항목
            </button>
            <button role="menuitem">로그아웃</button>
          </div>
          <p role="alert">문제</p>
        </div>
      )}
      <a href="#after">다음</a>
    </div>
  );
}

const key = (key: string) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

describe('팝오버 메뉴', () => {
  it('위아래 화살표·Home·End로 항목을 옮겨 다니고 끝에서 처음으로 돈다', () => {
    expect(nextMenuIndex('ArrowDown', -1, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', -1, 3)).toBe(2);
    expect(nextMenuIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', 0, 3)).toBe(2);
    expect(nextMenuIndex('Home', 1, 3)).toBe(0);
    expect(nextMenuIndex('End', 0, 3)).toBe(2);
    expect(nextMenuIndex('ArrowRight', 0, 3)).toBeNull();
  });

  it('열면 첫 항목으로 가고, 꺼진 항목은 건너뛰며, Esc는 닫고 여는 단추로 돌려보낸다', async () => {
    const { container, unmount } = await mount(<Menu />);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-expanded]')!;
    trigger.focus();
    await act(async () => trigger.click());
    const items = () => [...container.querySelectorAll<HTMLElement>('[role^=menuitem]')];
    expect(document.activeElement).toBe(items()[0]);
    // An alert is said beside the menu, not inside it.
    expect(container.querySelector('[role=menu] [role=alert]')).toBeNull();
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('밝게');
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('로그아웃');
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('내 섬');
    await key('End');
    expect(document.activeElement?.textContent).toBe('로그아웃');
    await key('Escape');
    expect(container.querySelector('[role=menu]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await unmount();
  });

  it('바깥을 누르거나 Tab으로 메뉴 밖에 나가면 닫는다', async () => {
    const { container, unmount } = await mount(<Menu />);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-expanded]')!;
    await act(async () => trigger.click());
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[role=menu]')).toBeNull();

    await act(async () => trigger.click());
    const last = container.querySelector<HTMLElement>('a[href="#after"]')!;
    const outside = document.body.appendChild(document.createElement('button'));
    await act(async () => {
      outside.focus();
    });
    expect(container.querySelector('[role=menu]')).toBeNull();
    expect(last).toBeTruthy();
    outside.remove();
    await unmount();
  });
});
