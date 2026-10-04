import { afterEach, describe, expect, it } from 'vitest';

import type { BuildingSerializedState, PlacedObject } from 'gaesup-world/building';

import { mount } from '../../__tests__/mount';
import { footprintsOverlap, objectFootprint, type XZ } from '../../minihome/edit/layout';
import { createVillage, SPAWN } from '../../minihome/village';
import type { GameProps } from '../game';
import { ox, type OxResult, type OxView } from '../ox';
import { oxLayout, ZONE_RADIUS } from '../ox/layout';
import { OxPanel, OxRanking } from '../ox/Panel';
import type { GameSession, Vec3 } from '../protocol';
import { gameOf } from '../registry';
import { openSpots } from '../spots';

const NOW = 7_000_000;
const me = { id: 'me', name: '나', peer: 'peer-me' };
const friend = { id: 'friend', name: '친구', peer: 'peer-friend' };
const third = { id: 'third', name: '셋째', peer: null };
const person = ({ id, name }: { id: string; name: string }) => ({ id, name });

const asking: OxView = {
  round: 3,
  rounds: 10,
  statement: '고래는 포유류예요.',
  phase: 'question',
  endsAt: NOW + 9_000,
  answer: null,
  fallen: [],
  survivors: [me, friend, third].map(person),
  out: [],
  me: { state: 'in', zone: 'o' },
  zones: { o: [-8, 0, 0], x: [8, 0, 0], radius: 4.5 },
};

function props<View>(view: View, you = me.id): GameProps<View> {
  const session: GameSession<View> = {
    kind: 'ox', phase: 'playing', host: me.id, players: [me, friend, third], you, game: view, result: null, seq: 4, now: NOW,
  };
  return {
    session,
    view,
    me: session.players.find((player) => player.id === you) ?? null,
    act: () => true,
    onEvent: () => () => {},
    serverNow: () => NOW,
    teleport: () => false,
  };
}

const mounted: { unmount: () => Promise<void> }[] = [];

async function panel(view: OxView, you?: string) {
  const shown = await mount(<OxPanel {...props(view, you)} />);
  mounted.push(shown);
  const facts = () => [...shown.container.querySelectorAll('.mg-ox-facts > div')].map((fact) => fact.textContent);
  return { container: shown.container, facts };
}

describe('OX 퀴즈 패널', () => {
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
  });

  it('문제를 크게 보여 주고 남은 시간, 몇 번째 문제인지, 내 자리, 남은 사람 수를 보여 준다', async () => {
    const { container, facts } = await panel(asking);
    expect(container.querySelector('.mg-ox-statement')!.textContent).toBe('고래는 포유류예요.');
    expect(container.querySelector('[role="timer"]')!.textContent).toBe('0:09');
    expect(container.querySelector('.mg-badge')!.textContent).toBe('문제 3/10');
    expect(facts()).toEqual(['내 자리O', '생존3명']);
    expect(container.querySelector('.mg-ox-facts .mg-ox-mark')!.getAttribute('data-zone')).toBe('o');
    // The answer is not out yet, and nobody is told they are out.
    expect(container.querySelector('.mg-ox-answer')).toBeNull();
    expect(container.querySelector('.mg-ox-out')).toBeNull();
  });

  it('어느 구역에도 서 있지 않으면 내 자리가 없음이다', async () => {
    const { facts } = await panel({ ...asking, me: { state: 'in', zone: null } });
    expect(facts()).toEqual(['내 자리없음', '생존3명']);
    const { facts: onX } = await panel({ ...asking, me: { state: 'in', zone: 'x' } });
    expect(onX()[0]).toBe('내 자리X');
  });

  it('정답이 나오면 정답과 이번에 탈락한 사람을 알린다', async () => {
    const answered: OxView = {
      ...asking,
      phase: 'answer',
      endsAt: NOW + 3_200,
      answer: 'o',
      fallen: [friend, third].map(person),
      survivors: [person(me)],
      out: [{ ...person(friend), round: 3 }, { ...person(third), round: 3 }],
    };
    const { container, facts } = await panel(answered);
    const said = container.querySelector('.mg-ox-answer')!;
    expect(said.getAttribute('role')).toBe('status');
    expect([...said.querySelectorAll('p')].map((line) => line.textContent)).toEqual(['정답 O', '탈락 친구, 셋째']);
    expect(said.querySelector('.mg-ox-mark')!.getAttribute('data-zone')).toBe('o');
    expect(container.querySelector('[role="timer"]')!.textContent).toBe('0:04');
    expect(facts()).toEqual(['내 자리O', '생존1명']);
    // The statement stays up with its answer.
    expect(container.querySelector('.mg-ox-statement')!.textContent).toBe('고래는 포유류예요.');
  });

  it('아무도 탈락하지 않은 정답도 그대로 알린다', async () => {
    const { container } = await panel({ ...asking, phase: 'answer', answer: 'x' });
    expect([...container.querySelectorAll('.mg-ox-answer p')].map((line) => line.textContent)).toEqual(['정답 X', '탈락 없어요']);
  });

  it('탈락한 사람에게는 탈락했다고 보여 준다', async () => {
    const { container } = await panel({ ...asking, me: { state: 'out', zone: null }, survivors: [friend, third].map(person) }, me.id);
    expect(container.querySelector('.mg-ox-out')!.textContent).toBe('탈락했어요');
  });

  it('구경하는 사람에게는 내 자리 없이 남은 사람 수만 보인다', async () => {
    const { container, facts } = await panel({ ...asking, me: null }, 'watcher');
    expect(facts()).toEqual(['생존3명']);
    expect(container.querySelector('.mg-ox-out')).toBeNull();
  });

  it('끝나면 남은 사람이 우승이고, 탈락한 사람은 늦게 탈락한 순서로 같은 문제면 같은 순위다', async () => {
    const result: OxResult = {
      winners: [person(friend)],
      out: [
        { ...person(me), round: 7 },
        { ...person(third), round: 7 },
        { id: 'fourth', name: '넷째', round: 2 },
      ],
    };
    const shown = await mount(<OxRanking {...props(asking)} result={result} />);
    mounted.push(shown);
    const rows = [...shown.container.querySelectorAll('.mg-game-scores li')];
    expect(rows.map((row) => row.textContent)).toEqual(['1위친구우승', '2위나7번 문제 탈락', '2위셋째7번 문제 탈락', '4위넷째2번 문제 탈락']);
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true', null, null]);
    expect(shown.container.querySelector('ol')!.getAttribute('aria-label')).toBe('순위');
  });
});

describe('OX 퀴즈 배치', () => {
  const village = createVillage();
  const spots = openSpots(village, { bounds: () => undefined });
  const host: Vec3 = [SPAWN[0], 0, SPAWN[2]];
  const ground = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
  /** How many of the island's open spots a zone around `spot` takes in, itself included. */
  const room = (spot: Vec3) => spots.filter((other) => ground(other, spot) <= ZONE_RADIUS).length;
  const zone = ([x, , z]: Vec3): XZ[] =>
    Array.from({ length: 12 }, (_, index) => [x + ZONE_RADIUS * Math.cos((index * Math.PI) / 6), z + ZONE_RADIUS * Math.sin((index * Math.PI) / 6)]);
  /** The placed things on `building` that reach into a zone around `spot`. */
  const inside = (building: BuildingSerializedState, spot: Vec3) =>
    building.objects.filter((object) => footprintsOverlap(zone(spot), objectFootprint(object)));
  const tree = (object: PlacedObject) => object.type === 'tree' || object.type === 'sakura' || !!object.config?.modelId?.includes('tree');
  const grassAt = (building: BuildingSerializedState, [x, , z]: Vec3) =>
    building.tileGroups.some((group) => group.tiles.some((tile) => tile.objectType === 'grass' && tile.position.x === x && tile.position.z === z));

  it('방장에게서 몇 걸음 떨어진 탁 트인 빈 자리 둘을 12–30m 떨어뜨려 고르고, 서쪽이 O다', () => {
    const { o, x } = oxLayout(spots, host, village);
    expect(spots).toContainEqual(o);
    expect(spots).toContainEqual(x);
    expect(ground(o, x)).toBeGreaterThanOrEqual(12);
    expect(ground(o, x)).toBeLessThanOrEqual(30);
    expect(o[0]).toBeLessThan(x[0]);
    // A few steps from the host on either side, so nobody starts inside a zone and both are a short walk.
    for (const spot of [o, x]) {
      expect(ground(host, spot)).toBeGreaterThan(ZONE_RADIUS + 1);
      expect(ground(host, spot)).toBeLessThan(12);
      expect(room(spot)).toBeGreaterThanOrEqual(4);
      expect(inside(village, spot).filter(tree)).toEqual([]);
      expect(grassAt(village, spot)).toBe(false);
    }
  });

  it('방장이 어디 있느냐에 따라 그 가까이에 둔다', () => {
    for (const around of [[-20, 0, 20], [-20, 0, -18], [16, 0, 12]] as Vec3[]) {
      const { o, x } = oxLayout(spots, around, village);
      expect(ground(o, x)).toBeGreaterThanOrEqual(12);
      expect(ground(o, x)).toBeLessThanOrEqual(30);
      expect(Math.max(ground(around, o), ground(around, x)), `${around}`).toBeLessThan(17);
    }
    // Nowhere yet: around the middle of the island's spots.
    const { o, x } = oxLayout(spots, null, village);
    expect(ground(o, x)).toBeGreaterThanOrEqual(12);
    expect(spots).toContainEqual(o);
  });

  it('나무가 서 있거나 풀이 우거진 곳은 피한다', () => {
    // An open field of 4 m cells, the host in the middle: O and X go 8 m to either side.
    const field: Vec3[] = [];
    for (let x = -16; x <= 16; x += 4) for (let z = -4; z <= 4; z += 4) field.push([x, 0, z]);
    const middle: Vec3 = [0, 0, 0];
    const bare: BuildingSerializedState = { ...village, objects: [], blocks: [], tileGroups: [] };
    expect(oxLayout(field, middle, bare)).toEqual({ o: [-8, 0, 0], x: [8, 0, 0] });
    // A cherry tree by the eastern spot: X moves off it.
    const sakura: PlacedObject = { id: 'sakura', type: 'sakura', position: { x: 9, y: 0, z: 1 }, config: { treeKind: 'sakura', size: 3.4 } };
    const wooded = { ...bare, objects: [sakura] };
    const shaded = oxLayout(field, middle, wooded);
    expect(inside(wooded, shaded.o)).toEqual([]);
    expect(inside(wooded, shaded.x)).toEqual([]);
    // Tall grass along the western spot's column: O moves out of it.
    const tiles = field.filter(([x]) => x === -8).map(([x, y, z], index) => ({ id: `g${index}`, tileGroupId: 'g', objectType: 'grass' as const, position: { x, y, z } }));
    const grassy: BuildingSerializedState = { ...bare, tileGroups: [{ id: 'g', name: 'g', floorMeshId: 'lawn', tiles }] };
    const hidden = oxLayout(field, middle, grassy);
    expect(hidden.o).not.toEqual([-8, 0, 0]);
    expect([grassAt(grassy, hidden.o), grassAt(grassy, hidden.x)]).toEqual([false, false]);
  });

  it('두 자리를 둘 곳이 없으면 그 이유로 시작하지 않는다', () => {
    const cramped: Vec3[] = [[0, 0, 0], [4, 0, 0], [8, 0, 0], [8, 0, 4]];
    expect(() => oxLayout(cramped, [0, 0, 0])).toThrow('O와 X를 놓을 자리가 없어요.');
    expect(() => oxLayout([], null)).toThrow('O와 X를 놓을 자리가 없어요.');
    // 0–40 is too far apart; of the two pairs that fit, the one around the host.
    const line: Vec3[] = [[0, 0, 0], [40, 0, 0], [16, 0, 0]];
    expect(oxLayout(line, [8, 0, 0])).toEqual({ o: [0, 0, 0], x: [16, 0, 0] });
    expect(oxLayout(line, [36, 0, 0])).toEqual({ o: [16, 0, 0], x: [40, 0, 0] });
  });

  it('등록부의 OX 퀴즈가 방장의 시작에 이 배치를 보낸다', () => {
    expect(gameOf('ox')).toBe(ox);
    expect([ox.label, ox.minPlayers, ox.maxPlayers]).toEqual(['OX 퀴즈', 2, 30]);
    const session = { kind: 'ox' } as GameSession;
    const layout = ox.layout({ building: village, spots: () => spots, position: host, session });
    expect(layout).toEqual(oxLayout(spots, host, village));
  });
});
