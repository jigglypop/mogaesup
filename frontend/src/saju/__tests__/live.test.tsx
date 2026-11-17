import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';

const { ticket } = vi.hoisted(() => ({ ticket: vi.fn() }));
vi.mock('../../api/endpoints', () => ({ authApi: { realtimeTicket: ticket } }));

const { dogOfUrl, SELF, useVillageRoom } = await import('../live');
type Room = ReturnType<typeof useVillageRoom>;

/** The room hook mounted in a component, its latest answer in `result.current`. */
async function mountHook(use: () => Room) {
  const result: { current: Room } = { current: null as unknown as Room };
  function Probe() {
    result.current = use();
    return null;
  }
  const page = await mount(<Probe />);
  return { result, unmount: () => page.unmount() };
}

/** A socket the test plays the server's part on. */
class Socket {
  static made: Socket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly url: string) {
    Socket.made.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  fire(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = 1;
    this.fire('open');
  }
  tell(message: unknown) {
    this.fire('message', { data: JSON.stringify(message) });
  }
}

describe('섬의 방', () => {
  beforeEach(() => {
    Socket.made = [];
    vi.stubGlobal('WebSocket', Socket);
    ticket.mockResolvedValue({ ticket: 't1', user: { id: 'me' } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('모델 주소에서 강아지를 읽는다', () => {
    expect(dogOfUrl('https://mogaesup.com/gltf/guardians/08.glb')).toBe('08');
    expect(dogOfUrl(undefined)).toBe('02');
  });

  it('들어가면 자기 강아지로 인사하고, 다른 사람이 오고 움직이고 말하고 나가는 것을 받는다', async () => {
    const hook = await mountHook(() => useVillageRoom('sol', 'me', '08', [1, 0, 2]));
    await act(async () => undefined);
    const socket = Socket.made[0]!;
    expect(socket.url).toContain('/api/rooms/sol?ticket=t1');
    await act(async () => socket.open());
    expect(socket.sent[0]).toMatchObject({ type: 'Join', room_id: 'sol', modelUrl: expect.stringMatching(/\/gltf\/guardians\/08\.glb$/) });
    await act(async () => socket.tell({ type: 'Welcome', client_id: 'me1', room_state: [['p2', { name: '보리', position: [3, 0, 4], rotation: [1, 0, 0, 0], modelUrl: 'http://x/gltf/guardians/16.glb' }]] }));
    expect(hook.result.current.present).toEqual(['p2']);
    expect(hook.result.current.others.get('p2')).toMatchObject({ name: '보리', dog: '16', position: [3, 0, 4] });
    await act(async () => socket.tell({ type: 'PlayerUpdate', client_id: 'p2', state: { position: [5, 0, 4], animation: 'walk' } }));
    expect(hook.result.current.others.get('p2')).toMatchObject({ position: [5, 0, 4], walking: true, name: '보리' });
    await act(async () => socket.tell({ type: 'Chat', client_id: 'p2', text: '안녕' }));
    expect(hook.result.current.said.get('p2')?.text).toBe('안녕');
    await act(async () => socket.tell({ type: 'PlayerLeft', client_id: 'p2' }));
    expect(hook.result.current.present).toEqual([]);
    await hook.unmount();
  });

  it('말하면 서버로 보내고 자기 머리 위에도 띄운다; 빈 말은 보내지 않는다', async () => {
    const hook = await mountHook(() => useVillageRoom('sol', 'me', '08', [0, 0, 0]));
    await act(async () => undefined);
    const socket = Socket.made[0]!;
    await act(async () => socket.open());
    let sent = false;
    await act(async () => void (sent = hook.result.current.say('  반가워요 ')));
    expect(sent).toBe(true);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'Chat', text: '반가워요' });
    expect(hook.result.current.said.get(SELF)?.text).toBe('반가워요');
    await act(async () => void (sent = hook.result.current.say('   ')));
    expect(sent).toBe(false);
    await hook.unmount();
  });

  it('로그인하지 않은 사람은 방에 들어가지 않는다', async () => {
    const hook = await mountHook(() => useVillageRoom('sol', null, '08', [0, 0, 0]));
    await act(async () => undefined);
    expect(Socket.made).toHaveLength(0);
    await hook.unmount();
  });
});
