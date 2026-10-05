import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { hiddenPeers } from '../hiddenPeers';
import type { ImpostorMeeting, ImpostorView } from '../impostor';
import { useImpostorSync } from '../impostor/sync';
import type { GameSession, SessionPlayer, Vec3 } from '../protocol';

const players: SessionPlayer[] = [
  { id: 'me', name: '나', peer: 'peer-me' },
  { id: 'b', name: '비', peer: 'peer-b' },
  { id: 'c', name: '씨', peer: 'peer-c' },
  { id: 'd', name: '디', peer: null },
];

const view = (changes: Partial<ImpostorView> = {}) =>
  ({ phase: 'play', alive: true, hidden: [], spawn: null, venting: null, vents: [], meeting: null, ...changes }) as ImpostorView;

const meeting = (number: number, seat: Vec3 | null, voted = 0) => ({ number, seat, voted }) as ImpostorMeeting;

type Given = { view: ImpostorView; players?: SessionPlayer[]; teleport: (ground: Vec3) => boolean };

/** Where the viewer stands on the island before the game takes them to the ship. */
const HOME: Vec3 = [5, 1, 5];

function SyncHook({ view: shown, players: present = players, teleport }: Given) {
  const session = { kind: 'impostor', players: present, you: 'me' } as GameSession<ImpostorView>;
  useImpostorSync({ view: shown, session, teleport, position: here });
  return null;
}

const here = () => HOME;
const Sync = SyncHook;

const hidden = () => [...hiddenPeers.get()].sort();

describe('임포스터가 섬에서 하는 일', () => {
  afterEach(() => hiddenPeers.clear('impostor'));

  it('서버가 숨기라는 사람은 안 보이고, 게임을 떠나도 그대로이며, 끝나면 모두 보인다', async () => {
    const teleport = vi.fn(() => true);
    const shown = await mount(<Sync view={view({ hidden: ['b', 'd'] })} teleport={teleport} />);
    expect(hidden()).toEqual(['peer-b']);
    // B leaves the game but stays on the island: still hidden while the server says so.
    await shown.rerender(<Sync view={view({ hidden: ['b', 'c'] })} players={players.filter((player) => player.id !== 'b')} teleport={teleport} />);
    expect(hidden()).toEqual(['peer-b', 'peer-c']);
    // The viewer is never hidden from themselves; nothing hidden, everyone shows.
    await shown.rerender(<Sync view={view({ hidden: ['me'] })} teleport={teleport} />);
    expect(hidden()).toEqual([]);
    await shown.rerender(<Sync view={view({ hidden: ['c'] })} teleport={teleport} />);
    expect(hidden()).toEqual(['peer-c']);
    await shown.rerender(<Sync view={view({ phase: 'ended', hidden: ['b', 'c'] })} teleport={teleport} />);
    expect(hidden()).toEqual([]);
    await shown.rerender(<Sync view={view({ hidden: ['b', 'c'] })} teleport={teleport} />);
    expect(hidden()).toEqual(['peer-b', 'peer-c']);
    await shown.unmount();
    expect(hidden()).toEqual([]);
    expect(teleport).not.toHaveBeenCalled();
  });

  it('시작하면 우주선의 탁자 둘레 제자리로 한 번 옮기고, 끝나면 섬의 원래 자리로 돌려보낸다', async () => {
    const teleport = vi.fn((_ground: Vec3) => true);
    const shown = await mount(<Sync view={view({ spawn: [1.6, 80, 0] })} teleport={teleport} />);
    expect(teleport.mock.calls).toEqual([[[1.6, 80, 0]]]);
    await shown.rerender(<Sync view={view({ spawn: [1.6, 80, 0], hidden: ['c'] })} teleport={teleport} />);
    expect(teleport).toHaveBeenCalledTimes(1);
    await shown.rerender(<Sync view={view({ phase: 'ended', spawn: [1.6, 80, 0] })} teleport={teleport} />);
    expect(teleport.mock.calls.at(-1)).toEqual([HOME]);
    await shown.unmount();
    expect(teleport).toHaveBeenCalledTimes(2);
    // Left before the end (the World goes): home too.
    const again = vi.fn((_ground: Vec3) => true);
    const left = await mount(<Sync view={view({ spawn: [1.6, 80, 0] })} teleport={again} />);
    await left.unmount();
    expect(again.mock.calls).toEqual([[[1.6, 80, 0]], [HOME]]);
  });

  it('환풍구를 옮겨 갈 때마다 그 환풍구로 옮긴다', async () => {
    const teleport = vi.fn((_ground: Vec3) => true);
    const vents: Vec3[] = [[0, 0, 20], [20, 0, 20]];
    const shown = await mount(<SyncHook view={view({ vents })} teleport={teleport} />);
    expect(teleport).not.toHaveBeenCalled();
    await shown.rerender(<SyncHook view={view({ vents, hidden: ['c'] })} teleport={teleport} />);
    expect(teleport).toHaveBeenCalledTimes(0);
    // Into a vent where they stand: taken to it; on to the next; out and in again.
    await shown.rerender(<SyncHook view={view({ vents, venting: 0 })} teleport={teleport} />);
    expect(teleport.mock.calls.at(-1)).toEqual([[0, 0, 20]]);
    await shown.rerender(<SyncHook view={view({ vents, venting: 1 })} teleport={teleport} />);
    expect(teleport.mock.calls.at(-1)).toEqual([[20, 0, 20]]);
    await shown.rerender(<SyncHook view={view({ vents, venting: 1 })} teleport={teleport} />);
    expect(teleport).toHaveBeenCalledTimes(2);
    await shown.rerender(<SyncHook view={view({ vents, venting: null })} teleport={teleport} />);
    await shown.rerender(<SyncHook view={view({ vents, venting: 1 })} teleport={teleport} />);
    expect(teleport).toHaveBeenCalledTimes(3);
    await shown.unmount();
  });

  it('회의가 시작되면 살아 있는 사람을 자기 자리로 한 번 옮긴다', async () => {
    const teleport = vi.fn((_ground: Vec3) => true);
    const shown = await mount(<Sync view={view({ phase: 'discuss', meeting: meeting(1, [1.6, 0, 0]) })} teleport={teleport} />);
    expect(teleport.mock.calls).toEqual([[[1.6, 0, 0]]]);
    // The same meeting, updated: no second move.
    await shown.rerender(<Sync view={view({ phase: 'vote', meeting: meeting(1, [1.6, 0, 0], 2) })} teleport={teleport} />);
    await shown.rerender(<Sync view={view()} teleport={teleport} />);
    expect(teleport).toHaveBeenCalledTimes(1);
    await shown.rerender(<Sync view={view({ phase: 'discuss', meeting: meeting(2, [0, 0, 1.6]) })} teleport={teleport} />);
    expect(teleport.mock.calls.at(-1)).toEqual([[0, 0, 1.6]]);
    // The dead have no seat.
    await shown.rerender(<Sync view={view({ phase: 'discuss', alive: false, meeting: meeting(3, null) })} teleport={teleport} />);
    expect(teleport).toHaveBeenCalledTimes(2);
    await shown.unmount();
  });

  it('아직 옮길 몸이 없으면 다음 화면에서 다시 옮긴다', async () => {
    const teleport = vi.fn((_ground: Vec3) => false);
    const shown = await mount(<Sync view={view({ phase: 'discuss', meeting: meeting(1, [1.6, 0, 0]) })} teleport={teleport} />);
    teleport.mockReturnValue(true);
    await shown.rerender(<Sync view={view({ phase: 'discuss', meeting: meeting(1, [1.6, 0, 0], 1) })} teleport={teleport} />);
    await shown.rerender(<Sync view={view({ phase: 'discuss', meeting: meeting(1, [1.6, 0, 0], 2) })} teleport={teleport} />);
    expect(teleport).toHaveBeenCalledTimes(2);
    await shown.unmount();
  });
});
