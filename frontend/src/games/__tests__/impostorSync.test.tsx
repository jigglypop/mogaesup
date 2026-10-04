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
  ({ phase: 'play', alive: true, dead: [], meeting: null, ...changes }) as ImpostorView;

const meeting = (number: number, seat: Vec3 | null, voted = 0) => ({ number, seat, voted }) as ImpostorMeeting;

type Given = { view: ImpostorView; players?: SessionPlayer[]; teleport: (ground: Vec3) => boolean };

function Sync({ view: shown, players: present = players, teleport }: Given) {
  const session = { kind: 'impostor', players: present, you: 'me' } as GameSession<ImpostorView>;
  useImpostorSync({ view: shown, session, teleport });
  return null;
}

const hidden = () => [...hiddenPeers.get()].sort();

describe('임포스터가 섬에서 하는 일', () => {
  afterEach(() => hiddenPeers.clear('impostor'));

  it('살아 있는 사람과 구경꾼에게는 죽은 사람이 안 보이고, 게임을 떠나도 그대로이며, 죽은 사람과 끝난 뒤에는 모두 보인다', async () => {
    const teleport = vi.fn(() => true);
    const shown = await mount(<Sync view={view({ dead: ['b', 'd'] })} teleport={teleport} />);
    expect(hidden()).toEqual(['peer-b']);
    // B leaves the game but stays on the island: still a ghost to the living.
    await shown.rerender(<Sync view={view({ dead: ['b', 'c'] })} players={players.filter((player) => player.id !== 'b')} teleport={teleport} />);
    expect(hidden()).toEqual(['peer-b', 'peer-c']);
    // Onlookers see no ghosts either.
    await shown.rerender(<Sync view={view({ alive: null, dead: ['b', 'c'] })} teleport={teleport} />);
    expect(hidden()).toEqual(['peer-b', 'peer-c']);
    // The dead see everyone, and so does everyone once it is over.
    await shown.rerender(<Sync view={view({ alive: false, dead: ['me', 'b', 'c'] })} teleport={teleport} />);
    expect(hidden()).toEqual([]);
    await shown.rerender(<Sync view={view({ phase: 'ended', dead: ['b', 'c'] })} teleport={teleport} />);
    expect(hidden()).toEqual([]);
    await shown.rerender(<Sync view={view({ dead: ['b', 'c'] })} teleport={teleport} />);
    expect(hidden()).toEqual(['peer-b', 'peer-c']);
    await shown.unmount();
    expect(hidden()).toEqual([]);
    expect(teleport).not.toHaveBeenCalled();
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
