import { describe, expect, it } from 'vitest';

import { at, createVillage } from '../../minihome/village';
import { flat, impostorLayout } from '../impostor/layout';
import type { GameSession, Vec3 } from '../protocol';
import { gameOf } from '../registry';
import { openSpots } from '../spots';

/** No measured models: placed models count by their kind's size. */
const village = openSpots(createVillage(), { bounds: () => undefined });
const pairs = <T,>(items: readonly T[]) => items.flatMap((a, index) => items.slice(index + 1).map((b) => [a, b] as const));

describe('임포스터 배치', () => {
  it('모개숲에서는 방장 가까이 둘레가 트인 빈 자리에 탁자를, 서로 6m 넘게 떨어진 빈 자리 6~12곳에 작업대를 둔다', () => {
    const host: Vec3 = [at(8), 1, at(5)];
    const { stations, table } = impostorLayout({ spots: () => village, position: host });
    expect(village).toContainEqual(table);
    expect(flat(table, host)).toBeLessThanOrEqual(8);
    // Open floor on all four sides of it, for the seats.
    expect(village.filter((spot) => spot !== table && flat(spot, table) <= 4.5)).toHaveLength(4);
    expect(stations.length).toBeGreaterThanOrEqual(6);
    expect(stations.length).toBeLessThanOrEqual(12);
    for (const station of stations) {
      expect(village).toContainEqual(station);
      expect(flat(station, table)).toBeGreaterThanOrEqual(6);
    }
    for (const [a, b] of pairs(stations)) expect(flat(a, b)).toBeGreaterThanOrEqual(6);
    // Spread over the island, not bunched in one corner.
    expect(Math.max(...pairs(stations).map(([a, b]) => flat(a, b)))).toBeGreaterThan(30);
  });

  it('방장이 아직 서 있지 않으면 섬 가운데 가까이에 탁자를 둔다', () => {
    const xs = village.map((spot) => spot[0]);
    const zs = village.map((spot) => spot[2]);
    const middle: Vec3 = [(Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2];
    const { table } = impostorLayout({ spots: () => village, position: null });
    expect(flat(table, middle)).toBeLessThanOrEqual(8);
  });

  it('좁은 섬에서는 작업대를 더 가깝게 두고, 그래도 모자라면 시작하지 않는다', () => {
    // Three by three cells, 4 m apart: the table in the middle, the corners only 5.7 m from it.
    const small: Vec3[] = [];
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) small.push([x * 4, 0, z * 4]);
    const { stations, table } = impostorLayout({ spots: () => small, position: [4, 0, 4] });
    expect(table).toEqual([4, 0, 4]);
    expect(stations).toHaveLength(8);
    for (const [a, b] of pairs([table, ...stations])) expect(flat(a, b)).toBeGreaterThanOrEqual(4);
    // In a row 3 m apart, only three places stand 4 m from the table and from one another.
    const row: Vec3[] = Array.from({ length: 8 }, (_, index) => [index * 3, 0, 0]);
    expect(() => impostorLayout({ spots: () => row, position: null })).toThrow('작업 자리가 부족해요.');
    expect(() => impostorLayout({ spots: () => small.slice(0, 6), position: null })).toThrow('작업 자리가 부족해요.');
  });

  it('등록된 임포스터는 서버와 같은 kind와 인원이고, 섬에서 바로 배치를 만든다', () => {
    const game = gameOf('impostor')!;
    expect([game.kind, game.label, game.minPlayers, game.maxPlayers]).toEqual(['impostor', '임포스터', 4, 15]);
    const building = createVillage();
    const layout = game.layout({ building, spots: () => village, position: null, session: { kind: 'impostor' } as GameSession }) as {
      stations: Vec3[];
      table: Vec3;
    };
    expect(layout.stations.length).toBeGreaterThanOrEqual(6);
    for (const point of [layout.table, ...layout.stations]) for (const value of point) expect(Math.abs(value)).toBeLessThanOrEqual(200);
  });
});
