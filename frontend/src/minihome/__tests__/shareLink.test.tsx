import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { copyText, SharedToast, ShareLink, type Shared } from '../ShareLink';

const LINK = `${window.location.origin}/api/share/@mogae`;

/** A pointer like a phone's (coarse) or a mouse's. */
const pointer = (coarse: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query === '(pointer: coarse)', media: query }));

describe('링크 복사', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();
  const share = vi.fn<(data: ShareData) => Promise<void>>();
  const onShared = vi.fn<(result: Shared) => void>();
  /** What the browser offers here, set on its own objects for each test. */
  const offered = [
    [navigator, 'clipboard', { writeText }],
    [navigator, 'share', share],
  ] as const;
  beforeEach(() => {
    for (const [owner, name, value] of offered) Object.defineProperty(owner, name, { value, configurable: true });
    pointer(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [owner, name] of offered) Reflect.deleteProperty(owner, name);
    Reflect.deleteProperty(document, 'execCommand');
    for (const mock of [writeText, share, onShared]) mock.mockReset();
  });

  const press = async () => {
    const { container, unmount } = await mount(<ShareLink username="mogae" onShared={onShared} />);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="링크 복사"]')!;
    await act(async () => button.click());
    await unmount();
  };

  it('컴퓨터에서는 섬의 공유 링크를 복사하고 알린다', async () => {
    writeText.mockResolvedValueOnce(undefined);
    await press();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(LINK);
    expect(share).not.toHaveBeenCalled();
    expect(onShared).toHaveBeenCalledExactlyOnceWith('copied');
  });

  it('폰에서는 공유 창을 열고, 닫아도 아무것도 알리지 않는다', async () => {
    pointer(true);
    share.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await press();
    expect(share).toHaveBeenCalledExactlyOnceWith({ url: LINK });
    await press();
    expect(writeText).not.toHaveBeenCalled();
    expect(onShared).not.toHaveBeenCalled();
  });

  it('공유 창을 열 수 없으면 복사한다', async () => {
    pointer(true);
    share.mockRejectedValueOnce(new DOMException('not allowed', 'NotAllowedError'));
    writeText.mockResolvedValueOnce(undefined);
    await press();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(LINK);
    expect(onShared).toHaveBeenCalledExactlyOnceWith('copied');
  });

  it('클립보드를 쓸 수 없으면 예전 방식으로 복사하고, 그것도 안 되면 못 했다고 알린다', async () => {
    writeText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    expect(await copyText(LINK)).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
    execCommand.mockReturnValue(false);
    await press();
    expect(onShared).toHaveBeenCalledExactlyOnceWith('failed');
  });

  it('결과는 짧은 상태 한 줄로만 보여 준다', async () => {
    const copied = await mount(<SharedToast shared="copied" />);
    expect(copied.container.querySelector('[role=status]')?.textContent?.trim()).toBe('링크를 복사했어요');
    await copied.unmount();
    const failed = await mount(<SharedToast shared="failed" />);
    expect(failed.container.querySelector('[role=alert]')?.textContent).toBe('링크를 복사하지 못했어요');
    await failed.unmount();
    const none = await mount(<SharedToast shared={null} />);
    expect(none.container.textContent).toBe('');
    await none.unmount();
  });
});
