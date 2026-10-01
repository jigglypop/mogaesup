import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { AppErrorBoundary } from '../ErrorBoundary';

function Bomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error('boom');
  return <p>화면</p>;
}

describe('앱 전체 오류 경계', () => {
  const log = vi.spyOn(console, 'error');
  beforeEach(() => log.mockImplementation(() => {}));
  afterEach(() => log.mockReset());

  it('문제가 없으면 화면을 그대로 보여 준다', async () => {
    const { container, unmount } = await mount(
      <AppErrorBoundary>
        <Bomb armed={false} />
      </AppErrorBoundary>,
    );
    expect(container.textContent).toBe('화면');
    expect(container.querySelector('[role=alert]')).toBeNull();
    await unmount();
  });

  it('그리다 던지면 빈 화면 대신 안내와 다시 불러오기 버튼을 보인다', async () => {
    const onReload = vi.fn();
    const { container, unmount } = await mount(
      <AppErrorBoundary onReload={onReload}>
        <Bomb armed />
      </AppErrorBoundary>,
    );
    const alert = container.querySelector('[role=alert]');
    expect(alert?.textContent).toContain('문제가 생겼어요');
    expect(container.textContent).not.toContain('화면');
    expect(log).toHaveBeenCalledWith('[app]', expect.objectContaining({ message: 'boom' }));

    const button = container.querySelector('button')!;
    expect(button.textContent).toBe('다시 불러오기');
    expect(onReload).not.toHaveBeenCalled();
    await act(async () => button.click());
    expect(onReload).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('깊은 곳에서 던져도 잡는다', async () => {
    const { container, unmount } = await mount(
      <AppErrorBoundary>
        <div>
          <section>
            <Bomb armed />
          </section>
        </div>
      </AppErrorBoundary>,
    );
    expect(container.querySelector('[role=alert]')).not.toBeNull();
    await unmount();
  });
});
