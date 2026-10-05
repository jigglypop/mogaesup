import { describe, expect, it } from 'vitest';

import { ARENA_Y, cells, floorBoxes, wallBoxes } from '../arenaMap';
import { defaultOptions, flat, impostorLayout, optionsFor } from '../impostor/layout';
import { SHIP, SHIP_ROOMS, roomLabels, shipPlaces, walkable } from '../impostor/ship';
import type { GameSession, Vec3 } from '../protocol';
import { gameOf } from '../registry';

const pairs = <T,>(items: readonly T[]) => items.flatMap((a, index) => items.slice(index + 1).map((b) => [a, b] as const));

/** The room whose cells hold `point`, by its mark ('.' for a hall). */
function markAt(point: Vec3): string {
  const open = cells(SHIP, walkable);
  const near = open.find(({ col, row }) => {
    const width = Math.max(...SHIP.rows.map((line) => line.length));
    const x = (col - (width - 1) / 2) * SHIP.cell;
    const z = (row - (SHIP.rows.length - 1) / 2) * SHIP.cell;
    return Math.abs(point[0] - x) <= SHIP.cell / 2 && Math.abs(point[2] - z) <= SHIP.cell / 2;
  });
  return near?.mark ?? ' ';
}

describe('임포스터의 우주선', () => {
  it('섬 위 하늘에 떠 있고, 방 열네 개와 복도가 모두 이어져 있다', () => {
    expect(SHIP.origin[1]).toBe(ARENA_Y);
    const open = cells(SHIP, walkable);
    const key = (col: number, row: number) => `${col},${row}`;
    const floor = new Set(open.map(({ col, row }) => key(col, row)));
    const seen = new Set([key(10, 2)]);
    const queue = [[10, 2]];
    while (queue.length) {
      const [col, row] = queue.shift()!;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = key(col! + dc!, row! + dr!);
        if (floor.has(next) && !seen.has(next)) {
          seen.add(next);
          queue.push([col! + dc!, row! + dr!]);
        }
      }
    }
    expect(seen.size).toBe(floor.size);
    const marks = new Set(open.map(({ mark }) => mark));
    for (const room of SHIP_ROOMS) expect(marks).toContain(room.mark);
    expect(roomLabels()).toHaveLength(14);
    // Every floor cell is closed in: walls run along its open edges, and the floor slabs cover every cell.
    const walls = wallBoxes(SHIP, walkable);
    expect(walls.length).toBeGreaterThan(20);
    const slabs = floorBoxes(SHIP, walkable);
    const covered = slabs.reduce((sum, slab) => sum + (slab.size[0] / SHIP.cell) * (slab.size[2] / SHIP.cell), 0);
    expect(covered).toBe(open.length);
  });

  it('작업대 열두 곳은 방마다 서로 떨어져 있고, 원자로의 두 손은 원자로에, 정전·통신은 전기실·통신실에 있다', () => {
    const { stations, table, vents, walk, panels } = shipPlaces();
    expect(stations).toHaveLength(12);
    for (const station of stations) {
      expect(markAt(station)).not.toBe(' ');
      expect(flat(station, table)).toBeGreaterThanOrEqual(3.6);
    }
    for (const [a, b] of pairs(stations)) expect(flat(a, b)).toBeGreaterThanOrEqual(3.6);
    expect(markAt(table)).toBe('C');
    expect(panels.reactor.map((index) => markAt(stations[index]!))).toEqual(['R', 'R']);
    expect(markAt(stations[panels.lights]!)).toBe('L');
    expect(markAt(stations[panels.comms]!)).toBe('K');
    expect(vents.length).toBeGreaterThanOrEqual(2);
    expect(vents.length).toBeLessThanOrEqual(8);
    for (const vent of vents) {
      expect(markAt(vent)).not.toBe(' ');
      for (const station of stations) expect(flat(vent, station)).toBeGreaterThanOrEqual(2);
    }
    for (const [a, b] of pairs(vents)) expect(flat(a, b)).toBeGreaterThanOrEqual(2);
    // Bots walk every floor cell, four meters apart.
    expect(walk).toHaveLength(cells(SHIP, walkable).length);
    expect(walk.length).toBeLessThanOrEqual(400);
  });

  it('등록된 임포스터는 서버와 같은 kind와 인원이고, 시작하면 우주선의 자리와 방장 설정을 보낸다', () => {
    const game = gameOf('impostor')!;
    expect([game.kind, game.label, game.minPlayers, game.maxPlayers]).toEqual(['impostor', '임포스터', 1, 15]);
    const session = { kind: 'impostor', players: [{ id: 'me', name: '나', peer: 'p' }] } as GameSession;
    const layout = impostorLayout({ session, options: undefined });
    // Alone: five bots make a table of six, and the side is dealt.
    expect([layout.bots, layout.role]).toEqual([5, null]);
    expect(layout).toMatchObject(shipPlaces());
    // The whole layout fits the game socket's 16 KiB frames, within the server's bounds.
    expect(JSON.stringify({ type: 'Start', layout }).length).toBeLessThan(16 * 1024);
    for (const point of [layout.table, ...layout.stations, ...layout.vents, ...layout.walk]) {
      for (const value of point) expect(Math.abs(value)).toBeLessThanOrEqual(200);
    }
    const chosen = impostorLayout({ session, options: { bots: 3, role: 'impostor' } });
    expect([chosen.bots, chosen.role]).toEqual([3, 'impostor']);
  });

  it('봇은 넷이 안 되면 여섯을 채울 만큼으로 시작하고, 서버가 받는 범위를 넘지 않으며, 역할은 혼자일 때만 고른다', () => {
    expect([1, 2, 3, 4, 8].map((people) => defaultOptions(people).bots)).toEqual([5, 4, 3, 0, 0]);
    expect(optionsFor(undefined, 2)).toEqual({ bots: 4, role: 'random' });
    expect(optionsFor({ bots: 12, role: 'crew' }, 1)).toEqual({ bots: 9, role: 'crew' });
    expect(optionsFor({ bots: 9, role: 'crew' }, 10)).toEqual({ bots: 5, role: 'random' });
    expect(optionsFor({ bots: -2, role: 'boss' }, 1)).toEqual({ bots: 0, role: 'random' });
    expect(optionsFor({ bots: 2.5 }, 1)).toEqual({ bots: 5, role: 'random' });
  });
});
