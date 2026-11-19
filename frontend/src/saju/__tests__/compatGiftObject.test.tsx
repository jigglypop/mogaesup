import { act } from 'react';

import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { afterEach, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../scene/decorModel', () => ({ loadDecorModel: load }));

const { CompatGiftObject } = await import('../scene/CompatGiftObject');
const { PhotoAssets } = await import('../scene/works');

afterEach(() => vi.restoreAllMocks());

/** The gift in a picture being taken, and how many of its parts the picture still waits for. */
async function inPicture() {
  const assets = { pending: 0 };
  const page = await mount(
    <PhotoAssets.Provider value={assets}>
      <CompatGiftObject design={{ tone: 'union', from: 'wood', to: 'fire' }} />
    </PhotoAssets.Provider>,
  );
  return { assets, page };
}

it('사진은 선물 모형이 올라올 때까지 기다리고, 받지 못한 모형은 기다리지 않는다', async () => {
  // The page's own document does not know three's elements: what is looked at here is what the picture waits for.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let arrive: (model: Group) => void = () => {};
  load.mockReturnValueOnce(new Promise((resolve) => (arrive = resolve)));
  const waiting = await inPicture();
  expect(waiting.assets.pending).toBe(1);
  await act(async () => arrive(new Group().add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()))));
  expect(waiting.assets.pending).toBe(0);
  await waiting.page.unmount();

  load.mockRejectedValueOnce(new Error('없는 모형'));
  const lost = await inPicture();
  await act(async () => undefined);
  expect(lost.assets.pending).toBe(0);
  await lost.page.unmount();
});
