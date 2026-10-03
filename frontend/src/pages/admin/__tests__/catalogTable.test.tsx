import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../../__tests__/mount';
import { CatalogTable } from '../CatalogTable';

const props = (problem: string, onRetry = vi.fn()) => ({
  items: null,
  problem,
  onRetry,
  imports: [],
  busy: new Set<string>(),
  onPatch: vi.fn(async () => true),
  onStatus: vi.fn(),
  onBulk: vi.fn(async () => true),
  onPreview: vi.fn(),
  onVersions: vi.fn(),
});

describe('카탈로그 표의 불러오기', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  afterEach(() => vi.unstubAllGlobals());

  it('불러오는 동안에만 불러오는 중이고, 실패하면 문제와 다시 불러오기를 보인다', async () => {
    const loading = await mount(<CatalogTable {...props('')} />);
    expect(loading.container.textContent).toContain('카탈로그를 불러오는 중');
    expect(loading.container.querySelector('[role=alert]')).toBeNull();
    await loading.unmount();

    const onRetry = vi.fn();
    const failed = await mount(<CatalogTable {...props('카탈로그를 불러오지 못했어요: 잠시 후 다시 시도해 주세요', onRetry)} />);
    expect(failed.container.textContent).not.toContain('불러오는 중');
    expect(failed.container.querySelector('[role=alert]')?.textContent).toContain('카탈로그를 불러오지 못했어요');
    const retry = [...failed.container.querySelectorAll('button')].find((button) => button.textContent?.includes('다시 불러오기'))!;
    await act(async () => retry.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    await failed.unmount();
  });
});
