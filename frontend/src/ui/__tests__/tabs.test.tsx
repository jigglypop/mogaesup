import { act, useState } from 'react';

import { describe, expect, it } from 'vitest';

import { mount } from '../../__tests__/mount';
import { nextTabIndex, useTabs } from '../tabs';

const IDS = ['guestbook', 'neighbors', 'about'] as const;

function Panel() {
  const [tab, setTab] = useState<(typeof IDS)[number]>('guestbook');
  const tabs = useTabs(IDS, tab, setTab);
  return (
    <>
      <div {...tabs.list} aria-label="섬 이야기">
        {IDS.map((id) => (
          <button key={id} {...tabs.tab(id)}>
            {id}
          </button>
        ))}
      </div>
      {IDS.map((id) => (
        <div key={id} {...tabs.panel(id)}>
          <textarea aria-label={id} defaultValue="" />
        </div>
      ))}
    </>
  );
}

const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });

/** One form for every tab, as the sign-in page has, starting on a tab that is not among them. */
function SharedPanel({ start }: { start: string }) {
  const [tab, setTab] = useState(start);
  const tabs = useTabs(IDS as readonly string[], tab, setTab, { sharedPanel: true });
  return (
    <>
      <div {...tabs.list} aria-label="모드">
        {IDS.map((id) => (
          <button key={id} {...tabs.tab(id)}>
            {id}
          </button>
        ))}
      </div>
      <form {...tabs.panel(tab, { focusable: false })}>
        <input aria-label="아이디" />
      </form>
    </>
  );
}

describe('탭', () => {
  it('화살표·Home·End는 끝에서 처음으로 돌아가며 옮겨 간다', () => {
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTabIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextTabIndex('Home', 2, 3)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
    expect(nextTabIndex('Enter', 0, 3)).toBeNull();
    expect(nextTabIndex('ArrowRight', 0, 0)).toBeNull();
    // With none of the tabs selected, the first arrow lands on an end, not on the second tab.
    expect(nextTabIndex('ArrowRight', -1, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', -1, 3)).toBe(2);
  });

  it('수정자 키가 붙은 화살표는 탭을 옮기지 않는다', async () => {
    const { container, unmount } = await mount(<Panel />);
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    tabs[0]!.focus();
    for (const init of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      await press(tabs[0]!, 'ArrowRight', init);
      expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    }
    await unmount();
  });

  it('패널 하나를 함께 쓰면 고른 탭만 그 패널을 가리키고, 폼 패널은 Tab 순서에 들지 않는다', async () => {
    const { container, unmount } = await mount(<SharedPanel start="about" />);
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    const panel = container.querySelector<HTMLElement>('[role=tabpanel]')!;
    expect(tabs.map((tab) => tab.getAttribute('aria-controls'))).toEqual([null, null, panel.id]);
    expect(panel.hasAttribute('tabindex')).toBe(false);
    await unmount();
    // Selected is none of the tabs: ArrowRight goes to the first.
    const other = await mount(<SharedPanel start="" />);
    const first = other.container.querySelector<HTMLButtonElement>('[role=tab]')!;
    await press(first, 'ArrowRight');
    expect(first.getAttribute('aria-selected')).toBe('true');
    await other.unmount();
  });

  it('탭마다 패널이 있고, 고른 탭만 Tab 순서에 들며, 다른 패널은 숨긴 채 남긴다', async () => {
    const { container, unmount } = await mount(<Panel />);
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    const panels = [...container.querySelectorAll<HTMLElement>('[role=tabpanel]')];
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(panels.map((panel) => panel.hidden)).toEqual([false, true, true]);
    for (const [index, tab] of tabs.entries()) {
      expect(tab.getAttribute('aria-controls')).toBe(panels[index]!.id);
      expect(panels[index]!.getAttribute('aria-labelledby')).toBe(tab.id);
    }

    // What was typed in one panel is still there after visiting another.
    const note = container.querySelector<HTMLTextAreaElement>('textarea[aria-label=guestbook]')!;
    note.value = '쓰던 글';
    tabs[0]!.focus();
    await press(tabs[0]!, 'ArrowRight');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    expect(panels.map((panel) => panel.hidden)).toEqual([true, false, true]);
    await press(tabs[1]!, 'End');
    expect(document.activeElement).toBe(tabs[2]);
    await press(tabs[2]!, 'ArrowRight');
    expect(document.activeElement).toBe(tabs[0]);
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label=guestbook]')?.value).toBe('쓰던 글');
    await unmount();
  });
});
