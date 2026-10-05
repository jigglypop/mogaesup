import { act, useState } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { StatusPanel } from '../StatusPanel';

// One report, as the engine hands out between its samples (the panel keeps a history per new report).
const engine = vi.hoisted(() => ({
  report: {
    frames: { fps: 60, avgMs: 16, p50Ms: 16, p95Ms: 18, maxMs: 20 },
    render: { backend: 'webgpu-fallback', calls: 120, triangles: 1000 },
    engine: { geometries: 1, textures: 2, programs: 3, allocatedBytesEstimate: 0 },
    phases: null,
    memory: null,
    shadow: null,
    resolution: { pixelRatio: 1, maxPixelRatio: 1.5, adaptive: true },
    gpuMs: null,
    cpuBound: false,
    drawnFps: 60,
    fixedTicksPerSecond: 60,
    tier: 'high',
  },
  time: { hour: 9, minute: 5, season: 'spring', day: 3 },
}));
vi.mock('gaesup-world', () => ({
  FRAME_PHASES: [],
  useGameTime: () => engine.time,
  usePerformanceReport: () => engine.report,
}));
vi.mock('gaesup-world/building', () => ({
  useBuildingStore: (select: (state: unknown) => unknown) => select({ tileGroups: new Map(), wallGroups: new Map(), objects: [] }),
}));

function Page() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button aria-label="화면 설정" onClick={() => setOpen(true)} />
      {open && <StatusPanel onClose={() => setOpen(false)} />}
    </>
  );
}

describe('성능 패널', () => {
  it('열리면 키보드를 받고, Esc로 닫히면 연 버튼으로 돌려준다; 설명 툴팁은 없다', async () => {
    const { container, unmount } = await mount(<Page />);
    const opener = container.querySelector<HTMLButtonElement>('[aria-label="화면 설정"]')!;
    opener.focus();
    await act(async () => opener.click());
    const panel = container.querySelector<HTMLElement>('[role=dialog]')!;
    expect(document.activeElement).toBe(panel);
    expect(panel.querySelector('[title]')).toBeNull();
    await act(async () => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[role=dialog]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await unmount();
  });
});
