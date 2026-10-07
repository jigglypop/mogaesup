import { act } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';

vi.mock('../edit/LayoutComposer', () => ({ LayoutComposer: () => null }));
vi.mock('../ResidentsShelf', () => ({ ResidentsShelf: () => null }));

import type { PlacedObject } from 'gaesup-world/building';

import { Decorate } from '../Decorate';
import { SelectionInspector } from '../edit/Inspector';
import type { EditSession } from '../edit/session';
import type { ResidentStore } from '../residents';

/** A decorating session on the select tool with nothing picked, recording what the drawer asks of it. */
function fakeSession() {
  const state = { active: true, tool: 'select', part: 'object', selectedId: null, topDown: false, help: false, notice: null };
  return {
    getState: () => state,
    subscribe: () => () => {},
    enter: vi.fn(),
    exit: vi.fn(),
    setPart: vi.fn(),
    setTool: vi.fn(),
    setTopDown: vi.fn(),
    setHelp: vi.fn(),
    labels: new Map<string, string>(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('꾸미기 서랍', () => {
  it('종류 탭은 고른 탭만 보이는 패널을 가리킨다', async () => {
    const session = fakeSession();
    const { container, unmount } = await mount(
      <Decorate session={session as unknown as EditSession} studioItems={[]} residents={{} as ResidentStore} npcItems={[]} onChangeIsland={() => {}} ownerId="owner" />,
    );
    const tabs = [...container.querySelectorAll<HTMLElement>('[aria-label="종류"] [role=tab]')];
    expect(tabs.length).toBeGreaterThan(1);
    const named = tabs.filter((tab) => tab.hasAttribute('aria-controls'));
    expect(named).toHaveLength(1);
    expect(named[0]!.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById(named[0]!.getAttribute('aria-controls')!)?.getAttribute('role')).toBe('tabpanel');

    await act(async () => tabs[1]!.click());
    const now = [...container.querySelectorAll<HTMLElement>('[aria-label="종류"] [role=tab]')].filter((tab) => tab.hasAttribute('aria-controls'));
    expect(now).toHaveLength(1);
    expect(document.getElementById(now[0]!.getAttribute('aria-controls')!)?.getAttribute('aria-labelledby')).toBe(now[0]!.id);
    await unmount();
  });

  it('고른 물건의 머리에는 이름만 있고 사용법 안내는 없다', async () => {
    const session = fakeSession();
    const object = { id: 'chair', type: 'model', position: { x: 0, y: 0, z: 0 }, rotation: 0, config: { modelId: 'chair-basic', modelLabel: '의자' } };
    const { container, unmount } = await mount(
      <SelectionInspector session={session as unknown as EditSession} object={object as unknown as PlacedObject} />,
    );
    expect(container.querySelector('header')?.textContent).toBe('의자');
    expect(container.textContent).not.toContain('끌어서');
    await unmount();
  });

  // 섬 바꾸기 replaced 섬 처음 모습으로: the chooser it opens asks before anything changes, so the button itself does not.
  it('섬 바꾸기는 묻지 않고 섬 고르는 창을 연다', async () => {
    const session = fakeSession();
    const change = vi.fn();
    const ask = vi.spyOn(window, 'confirm');
    const { container, unmount } = await mount(
      <Decorate session={session as unknown as EditSession} studioItems={[]} residents={{} as ResidentStore} npcItems={[]} onChangeIsland={change} ownerId="owner" />,
    );
    expect([...container.querySelectorAll('button')].some((item) => item.textContent === '섬 처음 모습으로')).toBe(false);
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '섬 바꾸기')!;
    await act(async () => button.click());
    expect(change).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
    await unmount();
  });
});
