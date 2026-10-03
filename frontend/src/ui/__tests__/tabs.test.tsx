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

const press = (target: Element, key: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

describe('탭', () => {
  it('화살표·Home·End는 끝에서 처음으로 돌아가며 옮겨 간다', () => {
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTabIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextTabIndex('Home', 2, 3)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
    expect(nextTabIndex('Enter', 0, 3)).toBeNull();
    expect(nextTabIndex('ArrowRight', 0, 0)).toBeNull();
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
