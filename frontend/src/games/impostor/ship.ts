import { ARENA_Y, cellPoint, cells, type GridMap } from '../arenaMap';
import type { Vec3 } from '../protocol';

/**
 * 임포스터's map: a ship of fourteen rooms and the halls between them on 4 m cells, floating over the island (see
 * ../arenaMap.ts). The host's page sends its places as the game's layout: the stations (one task each, two at the
 * reactor), the cafeteria's table, the vents, which stations fix each sabotage, and every floor cell for the bots to
 * walk between (neighbours only, so they keep to the halls).
 */

export type ShipRoom = { mark: string; name: string; rect: [col: number, row: number, width: number, height: number] };

export const SHIP_ROOMS: readonly ShipRoom[] = [
  { mark: 'C', name: '식당', rect: [9, 1, 6, 5] },
  { mark: 'E', name: '위 엔진실', rect: [1, 1, 3, 3] },
  { mark: 'U', name: '아래 엔진실', rect: [1, 11, 3, 3] },
  { mark: 'R', name: '원자로', rect: [0, 6, 2, 3] },
  { mark: 'S', name: '보안실', rect: [3, 7, 2, 2] },
  { mark: 'M', name: '의무실', rect: [5, 4, 3, 3] },
  { mark: 'L', name: '전기실', rect: [5, 9, 3, 3] },
  { mark: 'T', name: '창고', rect: [9, 9, 4, 5] },
  { mark: 'A', name: '관리실', rect: [13, 7, 3, 3] },
  { mark: 'K', name: '통신실', rect: [13, 12, 3, 3] },
  { mark: 'W', name: '무기실', rect: [17, 1, 4, 3] },
  { mark: 'O', name: '산소실', rect: [17, 6, 3, 2] },
  { mark: 'N', name: '항해실', rect: [21, 6, 3, 4] },
  { mark: 'H', name: '보호막실', rect: [17, 11, 4, 3] },
];

/** The halls between the rooms. */
const HALLS: readonly [col: number, row: number, width: number, height: number][] = [
  [4, 2, 5, 1],
  [6, 3, 1, 1],
  [2, 4, 1, 7],
  [4, 12, 5, 1],
  [11, 6, 1, 3],
  [12, 7, 1, 1],
  [15, 2, 2, 1],
  [16, 3, 1, 10],
  [20, 6, 1, 2],
];

const HALL = '.';
const COLUMNS = 24;
const ROWS = 15;

function draw(): string[] {
  const grid = Array.from({ length: ROWS }, () => Array.from({ length: COLUMNS }, () => ' '));
  const fill = ([col, row, width, height]: readonly number[], mark: string) => {
    for (let r = row!; r < row! + height!; r++) for (let c = col!; c < col! + width!; c++) grid[r]![c] = mark;
  };
  for (const hall of HALLS) fill(hall, HALL);
  for (const room of SHIP_ROOMS) fill(room.rect, room.mark);
  return grid.map((line) => line.join(''));
}

export const SHIP: GridMap = { rows: draw(), cell: 4, origin: [0, ARENA_Y, 0] };

export const walkable = (mark: string) => mark !== ' ';

/** The stations by cell, in the order the layout sends them; `panels` below names them by this order. */
const STATIONS: readonly [col: number, row: number][] = [
  [2, 1], // 위 엔진실
  [2, 13], // 아래 엔진실
  [0, 6], // 원자로, one hand
  [0, 8], // 원자로, the other
  [6, 5], // 의무실
  [6, 10], // 전기실
  [10, 12], // 창고
  [14, 8], // 관리실
  [14, 13], // 통신실
  [19, 2], // 무기실
  [18, 6], // 산소실
  [22, 8], // 항해실
];

/** Which stations fix each sabotage: the lights at 전기실, the comms at 통신실, the reactor's two hands. */
export const SHIP_PANELS = { lights: 5, comms: 8, reactor: [2, 3] as [number, number] };

const VENTS: readonly [col: number, row: number][] = [
  [1, 3], // 위 엔진실
  [1, 11], // 아래 엔진실
  [1, 7], // 원자로
  [4, 8], // 보안실
  [5, 4], // 의무실
  [7, 9], // 전기실
  [20, 1], // 무기실
  [23, 9], // 항해실
];

/** The cafeteria's middle. */
const TABLE: [col: number, row: number] = [11.5, 3];

const at = ([col, row]: readonly [number, number]): Vec3 => cellPoint(SHIP, col, row);

export type ShipPlaces = {
  stations: Vec3[];
  table: Vec3;
  vents: Vec3[];
  walk: Vec3[];
  panels: typeof SHIP_PANELS;
};

/** The ship's places in world coordinates, as the layout carries them. */
export function shipPlaces(): ShipPlaces {
  return {
    stations: STATIONS.map(at),
    table: at(TABLE),
    vents: VENTS.map(at),
    walk: cells(SHIP, walkable).map(({ col, row }) => at([col, row])),
    panels: SHIP_PANELS,
  };
}

/** Each room's name over its middle. */
export function roomLabels(): { name: string; at: Vec3; mark: string }[] {
  return SHIP_ROOMS.map(({ name, mark, rect: [col, row, width, height] }) => ({
    name,
    mark,
    at: cellPoint(SHIP, col + (width - 1) / 2, row + (height - 1) / 2),
  }));
}
