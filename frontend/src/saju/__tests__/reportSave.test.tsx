import { act } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SajuReading } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { SaveReport } from '../ui/SaveReport';
import { personOf } from './people';

const { reportOf, pictureAt, saveBlob, island } = vi.hoisted(() => ({
  reportOf: vi.fn(),
  pictureAt: vi.fn(),
  saveBlob: vi.fn(),
  /** What the island's snapshot was handed: the test takes the picture when it likes. */
  island: { onShot: null as ((canvas: HTMLCanvasElement) => void) | null },
}));
vi.mock('../report/make', async (importOriginal) => ({ ...(await importOriginal<typeof import('../report/make')>()), reportOf, pictureAt }));
vi.mock('../snapshot', async (importOriginal) => ({ ...(await importOriginal<typeof import('../snapshot')>()), saveBlob }));
vi.mock('../scene/Snapshot', () => ({
  Snapshot: ({ onShot }: { onShot: (canvas: HTMLCanvasElement) => void }) => {
    island.onShot = onShot;
    return <i className="snapshot" />;
  },
}));

const noeul = personOf('noeul');
const READING: SajuReading = { saju: { summary: '요약', sections: [{ title: '성품', body: '본문' }] }, ziwei: null };

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets the promises the button waits on go on. */
const settle = () => act(async () => {});

async function renderButton(pictureUrl: string | null) {
  const view = await mount(<SaveReport name={noeul.name} birth={noeul.birth} reading={READING} pictureUrl={pictureUrl} />);
  const button = () => view.container.querySelector('button')!;
  const press = () => act(async () => button().click());
  return { ...view, button, press };
}

describe('PDF 저장', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    island.onShot = null;
  });

  it('미연시 그림을 표지에 싣고, 만드는 동안 버튼을 잠갔다가 <이름>-팔자피자.pdf로 저장한다', async () => {
    const image = new Image();
    pictureAt.mockResolvedValue(image);
    const made = deferred<Blob>();
    reportOf.mockReturnValue(made.promise);
    const view = await renderButton('/models/abc.webp');
    expect(view.button().textContent).toBe(' PDF 저장');
    expect(view.button().disabled).toBe(false);

    await view.press();
    expect(view.button().disabled).toBe(true);
    expect(view.button().textContent).toBe(' PDF 만드는 중…');
    expect(pictureAt).toHaveBeenCalledWith('/models/abc.webp');
    expect(reportOf).toHaveBeenCalledWith({ name: '노을', birth: noeul.birth, reading: READING, picture: image });
    expect(view.container.querySelector('.snapshot')).toBeNull();

    const pdf = new Blob(['%PDF'], { type: 'application/pdf' });
    made.resolve(pdf);
    await settle();
    expect(saveBlob).toHaveBeenCalledWith(pdf, '노을-팔자피자.pdf');
    expect(view.button().disabled).toBe(false);
    expect(view.button().textContent).toBe(' PDF 저장');
    expect(view.container.querySelector('[role=alert]')).toBeNull();
    await view.unmount();
  });

  it('그림이 없으면 섬을 따로 그려 표지에 싣고, 다 그리면 그리던 캔버스를 내린다', async () => {
    reportOf.mockResolvedValue(new Blob(['%PDF']));
    const view = await renderButton(null);
    await view.press();
    expect(pictureAt).not.toHaveBeenCalled();
    expect(view.container.querySelector('.snapshot')).not.toBeNull();
    expect(reportOf).not.toHaveBeenCalled();

    const drawn = document.createElement('canvas');
    await act(async () => island.onShot?.(drawn));
    await settle();
    expect(reportOf).toHaveBeenCalledWith({ name: '노을', birth: noeul.birth, reading: READING, picture: drawn });
    expect(view.container.querySelector('.snapshot')).toBeNull();
    expect(saveBlob).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('그림을 불러오지 못하면 섬을 그린다', async () => {
    pictureAt.mockRejectedValue(new Error('404'));
    reportOf.mockResolvedValue(new Blob(['%PDF']));
    const view = await renderButton('/models/gone.webp');
    await view.press();
    await settle();
    expect(view.container.querySelector('.snapshot')).not.toBeNull();
    await view.unmount();
  });

  it('섬이 끝내 그려지지 않으면 그림 없이 만든다', async () => {
    vi.useFakeTimers();
    reportOf.mockResolvedValue(new Blob(['%PDF']));
    const view = await renderButton(null);
    await view.press();
    expect(view.container.querySelector('.snapshot')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await settle();
    expect(reportOf).toHaveBeenCalledWith(expect.objectContaining({ picture: null }));
    expect(view.container.querySelector('.snapshot')).toBeNull();
    expect(saveBlob).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('만들지 못하면 짧게 알리고, 다시 누르면 지운다', async () => {
    pictureAt.mockResolvedValue(new Image());
    reportOf.mockRejectedValueOnce(new Error('canvas'));
    const view = await renderButton('/models/abc.webp');
    await view.press();
    await settle();
    expect(view.container.querySelector('[role=alert]')?.textContent).toBe('PDF를 만들지 못했어요');
    expect(view.button().disabled).toBe(false);
    expect(saveBlob).not.toHaveBeenCalled();

    const again = deferred<Blob>();
    reportOf.mockReturnValueOnce(again.promise);
    await view.press();
    expect(view.container.querySelector('[role=alert]')).toBeNull();
    again.resolve(new Blob(['%PDF']));
    await settle();
    expect(saveBlob).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('다 만들기 전에 화면을 떠나면 파일을 넘기지 않는다', async () => {
    pictureAt.mockResolvedValue(new Image());
    const made = deferred<Blob>();
    reportOf.mockReturnValue(made.promise);
    const view = await renderButton('/models/abc.webp');
    await view.press();
    await view.unmount();
    made.resolve(new Blob(['%PDF']));
    await settle();
    expect(saveBlob).not.toHaveBeenCalled();
  });
});
