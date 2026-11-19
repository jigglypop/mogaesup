import { act, type ReactNode } from 'react';

import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SharedIsland } from '../../api/types';
import { mount, type } from '../../__tests__/mount';

const saju = vi.hoisted(() => ({
  islands: vi.fn<() => Promise<{ islands: SharedIsland[] }>>(),
  island: vi.fn<(slug: string) => Promise<SharedIsland>>(),
  createIsland: vi.fn<(title: string) => Promise<SharedIsland>>(),
}));
vi.mock('../../api/endpoints', () => ({ sajuApi: saju }));
vi.mock('../../shell/Shell', () => ({ PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../saju/scene/Stage', () => ({ Stage: () => null }));
vi.mock('../../saju/scene/frames', () => ({ frameOf: () => ({}) }));
vi.mock('../../saju/saju.css', () => ({}));

import { IslandsPage } from '../IslandsPage';

const island = (slug: string): SharedIsland => ({ id: `id-${slug}`, slug, title: '호수', creator: 'host', createdAt: '2026-11-19T00:00:00Z' });
const submit = (container: HTMLElement) =>
  act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

describe('공용섬 만들기', () => {
  beforeEach(() => saju.islands.mockResolvedValue({ islands: [] }));
  afterEach(() => { for (const mock of Object.values(saju)) mock.mockReset(); });

  const open = () =>
    mount(
      <MemoryRouter initialEntries={['/islands']}>
        <Link to="/">처음으로</Link>
        <Routes>
          <Route path="/islands" element={<IslandsPage />} />
          <Route path="/island/:slug" element={<p>섬 화면</p>} />
          <Route path="/" element={<p>처음 화면</p>} />
        </Routes>
      </MemoryRouter>,
    );

  it('보내는 중에 다시 눌러도 섬을 하나만 만든다', async () => {
    let answer!: (value: SharedIsland) => void;
    saju.createIsland.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const { container, unmount } = await open();
    await type(container.querySelector('input')!, '호수');
    await submit(container);
    await submit(container);
    expect(saju.createIsland).toHaveBeenCalledExactlyOnceWith('호수');
    await act(async () => answer(island('abc123abc123')));
    expect(container.textContent).toContain('섬 화면');
    await unmount();
  });

  it('만들지 못하면 다시 누를 수 있다', async () => {
    saju.createIsland.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(island('abc123abc123'));
    const { container, unmount } = await open();
    await type(container.querySelector('input')!, '호수');
    await submit(container);
    await submit(container);
    expect(saju.createIsland).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('섬 화면');
    await unmount();
  });

  it('답이 오기 전에 화면을 떠났으면 만든 섬으로 데려가지 않는다', async () => {
    let answer!: (value: SharedIsland) => void;
    saju.createIsland.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const { container, unmount } = await open();
    await type(container.querySelector('input')!, '호수');
    await submit(container);
    await act(async () => container.querySelector('a')!.click());
    expect(container.textContent).toContain('처음 화면');
    await act(async () => answer(island('abc123abc123')));
    expect(container.textContent).toContain('처음 화면');
    expect(container.textContent).not.toContain('섬 화면');
    await unmount();
  });
});
