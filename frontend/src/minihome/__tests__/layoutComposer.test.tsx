import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuildingStore } from 'gaesup-world/building';
import { mount, type } from '../../__tests__/mount';
import { LayoutComposer } from '../edit/LayoutComposer';
import { interpretLayout, type LayoutProposal } from '../edit/layout';
import { createResidentStore } from '../residents';
import type { EditSession } from '../edit/session';
import type { User } from '../../api/types';

const state = vi.hoisted(() => ({ user: null as User | null, ready: false }));
const api = vi.hoisted(() => ({ interpret: vi.fn(), capabilities: vi.fn() }));
const actions = vi.hoisted(() => ({ apply: vi.fn(), measure: vi.fn(), propose: vi.fn() }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('../../api/endpoints', () => ({ layoutApi: api }));
const canvases = vi.hoisted(() => ({ mounted: 0 }));
vi.mock('@react-three/fiber', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    // One mount per renderer the preview would make.
    Canvas: () => {
      useEffect(() => { canvases.mounted++; }, []);
      return <canvas aria-label="실제 미리보기 장면" />;
    },
    useThree: vi.fn(),
  };
});
vi.mock('@react-three/drei', () => ({ OrbitControls: () => null }));
vi.mock('../edit/layout', async () => ({ ...await vi.importActual<typeof import('../edit/layout')>('../edit/layout'),
  applyLayout: actions.apply, measureLayoutCatalog: actions.measure, proposeLayout: actions.propose }));

const props = (ownerId = '1') => {
  const store = createBuildingStore();
  return { ownerId, residents: createResidentStore(),
    session: { runtime: { buildingStore: store }, pivot: () => ({ x: 0, z: 0 }) } as unknown as EditSession };
};
const render = async (element: ReactNode) => ({ ...await mount(element), container: document.body });
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll('button')].find(v => v.textContent === text)!;
async function open(container: HTMLElement) { await act(async () => button(container, '매장 배치').click()); }
async function create(container: HTMLElement, text = '12m × 12m 카페 2인') {
  const field = container.querySelector<HTMLTextAreaElement>('[role=dialog] textarea')!;
  if (!field.value) await type(field, text);
  await act(async () => button(container, '배치 만들기').click());
}

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); canvases.mounted = 0;
  state.user = { id: '1', username: 'owner', displayName: 'owner', role: 'user', permissions: [] };
  api.capabilities.mockResolvedValue({ rules: true, ai: false });
  actions.measure.mockResolvedValue([]);
  actions.propose.mockImplementation((snapshot, intent) => ({ id: 'layout-1', baseline: JSON.stringify(snapshot), snapshot, intent,
    objects: [], walls: [], floor: { min: [-2, -2], max: [10, 10], color: '#ffffff' }, entrance: [4, 10], corridorX: 4,
    corridor: { minZ: 0, maxZ: 10 }, measured: [], notice: [] } satisfies LayoutProposal));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('매장 배치 화면', () => {
  it('회원은 무료로 설명을 입력하고 별도 미리보기 후에만 적용한다', async () => {
    const { container, unmount } = await render(<LayoutComposer {...props()} />);
    await open(container);
    expect(container.querySelector('input[type=checkbox]')).toBeNull();
    await create(container);
    expect(container.querySelector('[aria-label="실제 미리보기 장면"]')).not.toBeNull();
    // Only the island's placed models are measured besides the planner's own pieces, not the furniture catalog.
    expect(actions.measure).toHaveBeenCalledWith([]);
    expect(actions.propose).toHaveBeenCalledOnce();
    expect(actions.apply).not.toHaveBeenCalled();
    expect(api.interpret).not.toHaveBeenCalled();
    await act(async () => button(container, '섬에 적용').click());
    expect(actions.apply).toHaveBeenCalledOnce();
    expect(container.querySelector('[role=dialog]')).toBeNull();
    await unmount();
  });

  it('소유자가 아니면 매장 배치가 열리지 않는다', async () => {
    const { container, unmount } = await render(<LayoutComposer {...props('2')} />);
    expect(button(container, '매장 배치').disabled).toBe(true);
    expect(api.capabilities).not.toHaveBeenCalled();
    await unmount();
  });

  it('운영자도 AI 설정이 없는 경우 무료 규칙만 쓴다', async () => {
    state.user!.permissions = ['paid_operator'];
    const { container, unmount } = await render(<LayoutComposer {...props()} />);
    await open(container);
    expect(api.capabilities).toHaveBeenCalledOnce();
    expect(container.querySelector('input[type=checkbox]')).toBeNull();
    await create(container);
    expect(api.interpret).not.toHaveBeenCalled();
    await unmount();
  });

  it('AI 설명은 로컬 파서의 범위 오류 없이 해석되며 새로 열어도 같은 유료 요청 ID를 쓴다', async () => {
    state.user!.permissions = ['paid_operator'];
    api.capabilities.mockResolvedValue({ rules: true, ai: true });
    api.interpret.mockImplementation(async body => {
      // The browser must write the receipt before making the paid request.
      const stored = JSON.parse(localStorage.getItem('mogaesup:draft:1:layout-interpretations')!);
      expect(stored[0].id).toBe(body.requestId);
      return { ...interpretLayout('24m×12m 카페'), interpretation: 'ai' };
    });
    const input = '36m x 12m 카페, 설명을 가능한 크기로 해석';
    for (let i = 0; i < 2; i++) {
      const { container, unmount } = await render(<LayoutComposer {...props()} />);
      await open(container); await type(container.querySelector('textarea')!, `${input}  `);
      await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
      await create(container);
      expect(container.querySelector('[role=alert]')).toBeNull();
      expect(container.textContent).toContain('24m × 12m');
      await unmount();
    }
    expect(api.interpret).toHaveBeenCalledTimes(2);
    expect(api.interpret.mock.calls[0]![0].requestId).toBe(api.interpret.mock.calls[1]![0].requestId);
    expect(api.interpret.mock.calls[0]![0].description).toBe(input);
  });

  it('주민이 미리보기 이후 이동했으면 그대로 적용하지 않는다', async () => {
    const input = props();
    const { container, unmount } = await render(<LayoutComposer {...input} />);
    await open(container); await create(container);
    vi.spyOn(input.residents, 'revision').mockReturnValue(10);
    await act(async () => button(container, '섬에 적용').click());
    expect(container.querySelector('[role=alert]')?.textContent).toContain('주민 위치가 바뀌었어요');
    expect(actions.apply).not.toHaveBeenCalled();
    await unmount();
  });

  it('설명은 비어서 열리고, 다시 만들어도 미리보기 캔버스를 새로 만들지 않는다', async () => {
    const { container, unmount } = await render(<LayoutComposer {...props()} />);
    await open(container);
    const field = container.querySelector<HTMLTextAreaElement>('[role=dialog] textarea')!;
    expect(field.value).toBe('');
    expect(button(container, '배치 만들기').disabled).toBe(true);
    await create(container);
    expect(canvases.mounted).toBe(1);
    // Changing the description leaves the last proposal on view, but it cannot be applied until it is made again.
    await type(field, '24m × 12m 매장');
    expect(button(container, '섬에 적용').disabled).toBe(true);
    expect(container.querySelector('[role=img]')?.className).toContain('is-stale');
    await act(async () => button(container, '배치 만들기').click());
    expect(actions.propose).toHaveBeenCalledTimes(2);
    expect(canvases.mounted).toBe(1);
    expect(button(container, '섬에 적용').disabled).toBe(false);
    await unmount();
  });

  it('열린 동안 키보드를 안에 두고, 만드는 중에도 포커스를 잃지 않으며, Esc로 닫으면 연 버튼으로 돌아간다', async () => {
    let finish!: (value: unknown) => void;
    actions.measure.mockImplementationOnce(() => new Promise(done => (finish = done)));
    const { container, unmount } = await render(<LayoutComposer {...props()} />);
    const opener = button(container, '매장 배치');
    opener.focus();
    await open(container);
    const dialog = container.querySelector<HTMLElement>('[role=dialog]')!;
    expect(document.activeElement).toBe(dialog.querySelector('textarea'));
    await type(dialog.querySelector('textarea')!, '12m × 12m 카페');
    const make = button(container, '배치 만들기');
    make.focus();
    await act(async () => make.click());
    // Busy: the button says so and keeps the keyboard, and a second press makes nothing more.
    expect(make.textContent).toBe('크기 확인 중…');
    expect(make.getAttribute('aria-disabled')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => make.click());
    expect(actions.measure).toHaveBeenCalledOnce();
    await act(async () => finish([]));
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[role=dialog]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await unmount();
  });

  it('AI 요청 기록은 최근 것만 남기고 회원의 초안과 함께 지워진다', async () => {
    state.user!.permissions = ['paid_operator'];
    api.capabilities.mockResolvedValue({ rules: true, ai: true });
    api.interpret.mockResolvedValue({ ...interpretLayout('12m×12m 카페'), interpretation: 'ai' });
    localStorage.setItem('mogaesup:draft:1:layout-interpretations',
      JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ description: `old ${index}`, id: `receipt-${String(index).padStart(4, '0')}` }))));
    const { container, unmount } = await render(<LayoutComposer {...props()} />);
    await open(container);
    await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    await create(container, '새 카페');
    const stored = JSON.parse(localStorage.getItem('mogaesup:draft:1:layout-interpretations')!) as { description: string }[];
    expect(stored).toHaveLength(20);
    expect(stored[0]!.description).toBe('old 1');
    expect(stored.at(-1)!.description).toBe('새 카페');
    await unmount();
  });
});
