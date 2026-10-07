import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount, type } from '../../__tests__/mount';
import type { PetBreed } from '../../api/types';
import { AdoptPet } from '../AdoptPet';
import { breedInfo, type PetController, type PetStatus } from '../controller';
import type { PetHome, PetHomeState } from '../persistence';
import { ATTRIBUTION_URL, PetButton, PetPanel, type PetIsland } from '../PetPanel';

const BREED: PetBreed = {
  id: 'pug', label: '퍼그', emoji: '🐶', modelUrl: '/gltf/pets/pug.glb', thumbnailUrl: '/gltf/pets/pug.webp',
  clips: ['idle', 'walk', 'sit', 'sit_hold'], heightM: 0.55,
};
const MASTERY = { come: 95, sit: 80, down: 10, stay: 30, fetch: 20, speak: 0, jump: 5 };

function fakeController(changes: Partial<PetStatus> = {}) {
  let status: PetStatus = {
    activity: 'sit',
    command: 'sit',
    drives: { energy: 70, satiety: 40, mood: 65, bond: 12 },
    mastery: MASTERY,
    canTreat: true,
    learning: true,
    busy: false,
    ...changes,
  };
  const listeners = new Set<() => void>();
  const controller = {
    status: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    command: vi.fn(() => true),
    throwBall: vi.fn(() => true),
    feedback: vi.fn((_kind: string) => true),
  };
  const set = (next: Partial<PetStatus>) => {
    status = { ...status, ...next };
    for (const listener of listeners) listener();
  };
  return { controller: controller as unknown as PetController, calls: controller, set };
}

function fakeHome(): PetHome & { [key: string]: ReturnType<typeof vi.fn> } {
  return {
    getState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    load: vi.fn(),
    adopt: vi.fn(async () => true),
    rename: vi.fn(async () => true),
    moveHome: vi.fn(async () => true),
    release: vi.fn(async () => true),
    reload: vi.fn(async () => {}),
    clearProblem: vi.fn(),
    dispose: vi.fn(),
  } as unknown as PetHome & { [key: string]: ReturnType<typeof vi.fn> };
}

const stateWith = (controller: PetController, changes: Partial<PetHomeState> = {}): PetHomeState => ({
  phase: 'ready',
  breeds: [],
  pet: { id: 'p1', name: '초코', breed: 'pug', breedInfo: BREED, home: { x: 0, z: 0 }, breedView: breedInfo(BREED) },
  controller,
  conflict: false,
  problem: '',
  ...changes,
});

const button = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim().startsWith(name) || element.getAttribute('aria-label') === name);
const click = (element: HTMLElement | undefined | null) => act(async () => element?.click());

let views: { unmount: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const view of views) await view.unmount();
  views = [];
});
async function render(...args: Parameters<typeof mount>) {
  const view = await mount(...args);
  views.push(view);
  return view;
}

describe('PetPanel', () => {
  it('shows what the pet does, how it feels and how well each command is learned', async () => {
    const { controller } = fakeController();
    const home = fakeHome();
    const { container } = await render(<PetPanel home={home} state={stateWith(controller)} controller={controller} spot={() => null} onClose={vi.fn()} />);
    expect(container.querySelector('.mg-pet-name')?.textContent).toBe('초코');
    expect(container.querySelector('.mg-pet-doing')?.textContent).toBe('앉아 있음');
    const bars = [...container.querySelectorAll('.mg-pet-bar')].map((bar) => bar.textContent);
    expect(bars).toEqual(['기분65', '기운70', '배부름40', '친밀도12']);
    const commands = [...container.querySelectorAll('.mg-pet-command')].map((element) => element.textContent);
    expect(commands).toEqual(['이리 와95%', '앉아80%', '엎드려10%', '기다려30%', '짖어0%', '점프5%', '공 던지기20%']);
    expect(button(container, '앉아')?.getAttribute('aria-pressed')).toBe('true');
    expect(button(container, '엎드려')?.getAttribute('aria-pressed')).toBe('false');
    expect(container.textContent).not.toContain('초파리');
  });

  it('sends commands and feedback, and throws the ball for 공 던지기', async () => {
    const { controller, calls, set } = fakeController();
    const { container } = await render(<PetPanel home={fakeHome()} state={stateWith(controller)} controller={controller} spot={() => null} onClose={vi.fn()} />);
    await click(button(container, '엎드려'));
    expect(calls.command).toHaveBeenCalledWith('down');
    await click(button(container, '공 던지기'));
    expect(calls.throwBall).toHaveBeenCalledTimes(1);
    await click(button(container, '간식'));
    await click(button(container, '칭찬'));
    await click(button(container, '안돼'));
    expect(calls.feedback.mock.calls.map(([kind]) => kind)).toEqual(['treat', 'praise', 'scold']);
    await act(async () => set({ canTreat: false, activity: 'fetchBall' }));
    expect(button(container, '간식')?.disabled).toBe(true);
    expect(container.querySelector('.mg-pet-doing')?.textContent).toBe('공 가지러 감');
  });

  it('takes 1–7, T and G while open, but not while typing', async () => {
    const { controller, calls } = fakeController();
    const { container } = await render(<PetPanel home={fakeHome()} state={stateWith(controller)} controller={controller} spot={() => null} onClose={vi.fn()} />);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '7' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'G' }));
    });
    expect(calls.command).toHaveBeenCalledWith('sit');
    expect(calls.throwBall).toHaveBeenCalledTimes(1);
    expect(calls.feedback.mock.calls.map(([kind]) => kind)).toEqual(['treat', 'praise']);
    await click(container.querySelector<HTMLButtonElement>('.mg-pet-name'));
    const field = container.querySelector<HTMLInputElement>('.mg-pet-rename input')!;
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true })));
    expect(calls.command).toHaveBeenCalledTimes(1);
  });

  it('renames, moves home to where the owner stands, links the circuit’s credit, and lets the pet go after asking', async () => {
    const { controller } = fakeController();
    const home = fakeHome();
    const onClose = vi.fn();
    const { container } = await render(<PetPanel home={home} state={stateWith(controller)} controller={controller} spot={() => ({ x: 5, z: -3 })} onClose={onClose} />);
    await click(container.querySelector<HTMLButtonElement>('.mg-pet-name'));
    const field = container.querySelector<HTMLInputElement>('.mg-pet-rename input')!;
    await type(field, '보리');
    await act(async () => field.form?.requestSubmit());
    expect(home.rename).toHaveBeenCalledWith('보리');

    await click(button(container, '펫 메뉴'));
    const credit = container.querySelector<HTMLAnchorElement>('.mg-pet-menu a');
    expect(credit?.textContent?.trim()).toBe('회로 출처');
    expect(credit?.getAttribute('href')).toBe(ATTRIBUTION_URL);
    await click(button(container, '여기를 집으로'));
    expect(home.moveHome).toHaveBeenCalledWith(5, -3);

    await click(button(container, '펫 메뉴'));
    await click(button(container, '떠나보내기'));
    expect(home.release).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    await click([...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((element) => element.textContent === '떠나보내기'));
    expect(home.release).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('after another page saved over it: commands off and 다시 불러오기', async () => {
    const { controller } = fakeController();
    const home = fakeHome();
    const { container } = await render(
      <PetPanel home={home} state={stateWith(controller, { conflict: true })} controller={controller} spot={() => null} onClose={vi.fn()} />,
    );
    expect(button(container, '앉아')?.disabled).toBe(true);
    expect(button(container, '간식')?.disabled).toBe(true);
    await click(button(container, '다시 불러오기'));
    expect(home.reload).toHaveBeenCalled();
  });

  it('while another of the owner’s pages has the pet, says so and takes no commands', async () => {
    const { controller } = fakeController({ busy: true });
    const { container } = await render(<PetPanel home={fakeHome()} state={stateWith(controller)} controller={controller} spot={() => null} onClose={vi.fn()} />);
    expect(container.querySelector('.mg-pet-doing')?.textContent).toBe('다른 창에서 함께하는 중');
    expect(button(container, '이리 와')?.disabled).toBe(true);
  });
});

describe('AdoptPet and the 펫 button', () => {
  it('adopts the chosen breed under a name of 1–12 characters', async () => {
    const onAdopt = vi.fn(async () => true);
    const breeds = [breedInfo(BREED), breedInfo({ ...BREED, id: 'shiba-inu', label: '시바견', modelUrl: '/gltf/pets/shiba-inu.glb' })];
    const { container } = await render(<AdoptPet breeds={breeds} onAdopt={onAdopt} problem="" onClose={vi.fn()} />);
    const adopt = () => button(container, '입양')!;
    expect(adopt().disabled).toBe(true);
    await click(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]);
    const field = container.querySelector<HTMLInputElement>('input')!;
    await type(field, '가나다라마바사아자차카타파');
    expect(adopt().disabled).toBe(true);
    await type(field, ' 보리 ');
    expect(adopt().disabled).toBe(false);
    await click(adopt());
    expect(onAdopt).toHaveBeenCalledWith('shiba-inu', '보리');
  });

  it('shows the 펫 button only with a breed to adopt or a pet', async () => {
    const pets = (state: PetHomeState | null): PetIsland => ({ home: null, state, open: false, setOpen: vi.fn(), chat: vi.fn() });
    const { controller } = fakeController();
    const none = await render(<PetButton pets={pets({ ...stateWith(controller), pet: null, breeds: [] })} />);
    expect(none.container.querySelector('button')).toBeNull();
    const some = await render(<PetButton pets={pets({ ...stateWith(controller), pet: null, breeds: [breedInfo(BREED)] })} />);
    expect(some.container.querySelector('button')?.getAttribute('aria-label')).toBe('펫');
    const loading = await render(<PetButton pets={pets(null)} />);
    expect(loading.container.querySelector('button')).toBeNull();
  });
});
