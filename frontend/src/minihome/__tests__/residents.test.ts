import { act, createElement } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { mount, type } from '../../__tests__/mount';
import type { CatalogItem } from '../../api/types';
import type { EditSession } from '../edit/session';
import {
  createGreetingStore,
  createResidentStore,
  FACE_RADIUS,
  lookTarget,
  MAX_RESIDENTS,
  NAME_MAX,
  parseResidents,
  residentInstance,
  residentsBinding,
  residentSpot,
  residentTemplate,
  residentText,
  shownResidents,
  type Resident,
} from '../residents';
import { ResidentsShelf } from '../ResidentsShelf';

const resident = (id: string, changes: Partial<Resident> = {}): Resident => ({
  id,
  npc: 'npc-mogae',
  name: '모개',
  greeting: '어서 와',
  position: [2, 0, -8],
  rotation: 0,
  ...changes,
});

const item = (id: string, changes: Partial<CatalogItem> = {}): CatalogItem => ({
  id,
  kind: 'npc',
  label: '모개',
  emoji: '🧑‍🌾',
  modelUrl: `/models/${id}.glb`,
  thumbnailUrl: null,
  clips: ['idle'],
  source: 'factory',
  sourceRef: null,
  status: 'published',
  sortOrder: 100,
  ...changes,
});

describe('섬 주민 저장', () => {
  it('저장된 주민을 서버와 같은 규칙으로 읽고, 하나라도 틀리면 통째로 거절한다', () => {
    expect(parseResidents(undefined)).toEqual([]);
    expect(parseResidents({ version: 1, residents: [resident('a')] })).toEqual([resident('a')]);
    const broken = [
      { version: 2, residents: [] },
      { version: 1, residents: [resident('a'), resident('a')] },
      { version: 1, residents: [resident('a', { name: '  ' })] },
      { version: 1, residents: [resident('a', { greeting: '줄\n바꿈' })] },
      { version: 1, residents: [resident('a', { name: '모개\ud83c' })] },
      { version: 1, residents: [resident('a', { npc: '../x' })] },
      { version: 1, residents: [resident('a', { position: [0, 0, 500] })] },
      { version: 1, residents: [{ ...resident('a'), modelUrl: 'https://evil.example/x.glb' }] },
      { version: 1, residents: Array.from({ length: MAX_RESIDENTS + 1 }, (_, i) => resident(`r${i}`)) },
    ];
    for (const data of broken) expect(() => parseResidents(data), JSON.stringify(data)).toThrow(TypeError);
  });

  it('섬 저장의 residents 영역으로 쓰고 읽으며, 바뀔 때마다 리비전이 오른다', () => {
    const store = createResidentStore();
    const binding = residentsBinding(store);
    expect(binding.key).toBe('residents');
    const before = binding.revision!();
    const added = store.add({ npc: 'npc-mogae', name: '모개', greeting: '안녕', position: [1, 0, 1], rotation: 0 })!;
    expect(binding.revision!()).toBeGreaterThan(before);
    expect(binding.serialize()).toEqual({ version: 1, residents: [added] });

    store.update(added.id, { greeting: '또 왔네' });
    const saved = binding.serialize();
    const other = createResidentStore();
    residentsBinding(other).hydrate(saved);
    expect(other.getState()).toEqual([{ ...added, greeting: '또 왔네' }]);

    // A malformed save changes nothing; a save without residents empties the island's.
    expect(() => residentsBinding(other).prepareHydrate!({ version: 1, residents: [{ id: 'x' }] })).toThrow();
    expect(other.getState()).toHaveLength(1);
    residentsBinding(other).reset!();
    expect(other.getState()).toEqual([]);
  });

  it('주민은 12명까지 두고, 고치거나 치우면 그 주민만 바뀐다', () => {
    const store = createResidentStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const ids = Array.from({ length: MAX_RESIDENTS }, () => store.add({ npc: 'npc-mogae', name: '모개', greeting: '', position: [0, 0, 0], rotation: 0 })!.id);
    expect(new Set(ids).size).toBe(MAX_RESIDENTS);
    expect(store.add({ npc: 'npc-mogae', name: '넘침', greeting: '', position: [0, 0, 0], rotation: 0 })).toBeNull();
    const [first, second] = store.getState();
    store.update(first!.id, { name: '새 이름' });
    expect(store.getState()[0]!.name).toBe('새 이름');
    expect(store.getState()[1]).toBe(second);
    store.remove(second!.id);
    expect(store.getState().map((entry) => entry.id)).not.toContain(second!.id);
    store.remove('nobody');
    expect(listener).toHaveBeenCalledTimes(MAX_RESIDENTS + 2);
  });

  it('이름과 인사말은 서버가 받는 글로 고친다: 붙여 넣은 탭은 빈칸으로, 이모지는 가운데에서 자르지 않는다', () => {
    expect(residentText(' 모개\t친구 ', NAME_MAX)).toBe('모개 친구');
    expect(residentText('\u0000\t', NAME_MAX)).toBe('');
    expect(residentText('모개\ud83c', NAME_MAX)).toBe('모개');
    // UTF-16으로 세면 20자 경계가 이모지 가운데에 걸린다. 반쪽만 남기지 않는다.
    expect(residentText('가나다라마바사아자차카타파하가나다라마🍄요정', NAME_MAX)).toBe('가나다라마바사아자차카타파하가나다라마🍄');
    expect([...residentText('😊'.repeat(NAME_MAX + 5), NAME_MAX)]).toHaveLength(NAME_MAX);
  });

  it('서버가 거절할 주민은 두지도 않고 그렇게 고치지도 않는다', () => {
    const store = createResidentStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const mogae: Omit<Resident, 'id'> = { npc: 'npc-mogae', name: '모개', greeting: '', position: [0, 0, 0], rotation: 0 };
    const refused = [{ name: '모개\t친구' }, { name: `${'가'.repeat(NAME_MAX - 1)}\ud83c` }, { name: ' ' }, { greeting: '어서\t와' }];
    for (const changes of refused) expect(store.add({ ...mogae, ...changes }), JSON.stringify(changes)).toBeNull();
    const added = store.add(mogae)!;
    for (const changes of refused) store.update(added.id, changes);
    expect(store.getState()).toEqual([added]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('꾸미기의 주민 칸', () => {
  const session = {
    pivot: () => ({ x: 10, y: 0, z: 10 }),
    runtime: { buildingStore: { getState: () => ({ tileGroups: new Map() }) } },
  } as unknown as EditSession;

  it('붙여 넣은 탭이나 이모지에 걸린 라벨은 고쳐서 두고, 고친 이름도 그렇게 저장한다', async () => {
    const residents = createResidentStore();
    const items = [item('npc-mogae', { label: '가나다라마바사아자차카타파하가나다라마🍄요정' })];
    const { container, unmount } = await mount(createElement(ResidentsShelf, { session, residents, items, query: '' }));
    // 이름 칸을 비워 두면 라벨이 이름이 된다.
    await type(container.querySelector<HTMLInputElement>('[name=residentGreeting]')!, '어서\t와');
    await act(async () => container.querySelector<HTMLButtonElement>('button[type=submit]')!.click());
    expect(residents.getState()).toMatchObject([{ name: '가나다라마바사아자차카타파하가나다라마🍄', greeting: '어서 와' }]);

    const name = container.querySelector<HTMLInputElement>('[aria-label="주민 이름"]')!;
    await type(name, '모개\t친구');
    await act(async () => name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(residents.getState()[0]!.name).toBe('모개 친구');
    expect(name.value).toBe('모개 친구');
    await unmount();
  });
});

describe('섬에 그리는 주민', () => {
  it('공개된 주민만 엔진의 NPC로 그리고, 모델은 카탈로그에서 온다', () => {
    const residents = [resident('a'), resident('b', { npc: 'npc-retired' })];
    expect(shownResidents(residents, [item('npc-mogae')]).map((entry) => entry.id)).toEqual(['a']);
    expect(residentTemplate(item('npc-mogae'))).toMatchObject({
      id: 'resident:npc-mogae',
      baseParts: [{ type: 'body', url: '/models/npc-mogae.glb' }],
      materialPolicy: 'figure',
    });
    const instance = residentInstance(resident('a', { rotation: 1.5 }));
    expect(instance).toMatchObject({ id: 'a', templateId: 'resident:npc-mogae', name: '모개', rotation: [0, 1.5, 0] });
    expect(instance.behavior).toMatchObject({ mode: 'idle', faceOnInteract: true });
    expect(instance.behavior?.turnSpeed).toBeGreaterThan(0);
  });

  it('새 주민은 보는 곳 가운데 서되 도착 자리와 다른 주민을 비켜 선다', () => {
    const spawn = [4, 1, -8];
    const ground = (x: number) => (x > 5 ? 0.5 : 0);
    expect(residentSpot({ x: 12.4, z: 3.6 }, [], spawn, ground)).toEqual([12, 0.5, 4]);
    const [x, , z] = residentSpot({ x: 4, z: -8 }, [], spawn, ground);
    expect(Math.hypot(x - 4, z + 8)).toBeGreaterThanOrEqual(1.5);
    const taken = [resident('a', { position: [12, 0, 4] })];
    const next = residentSpot({ x: 12, z: 4 }, taken, spawn, ground);
    expect(next).not.toEqual([12, 0.5, 4]);
    expect(Math.hypot(next[0] - 12, next[2] - 4)).toBeLessThanOrEqual(1.5);
  });

  it('가까이 온 사람을 바라보고, 멀어지면 놓인 방향으로 돌아간다', () => {
    expect(lookTarget([0, 0, 0], 0, [1, 0, 2])).toEqual({ near: true, target: [1, 0, 2] });
    const away = lookTarget([0, 0, 0], Math.PI / 2, [FACE_RADIUS + 1, 0, 0]);
    expect(away.near).toBe(false);
    expect(away.target[0]).toBeCloseTo(1);
    expect(away.target[2]).toBeCloseTo(0);
    expect(lookTarget([0, 0, 0], 0, null)).toEqual({ near: false, target: [0, 0, 1] });
  });

  it('인사 카드는 하나만 보이고 닫으면 사라진다', () => {
    const greetings = createGreetingStore();
    const listener = vi.fn();
    greetings.subscribe(listener);
    greetings.show({ id: 'a', name: '모개', greeting: '어서 와' });
    expect(greetings.get()).toEqual({ id: 'a', name: '모개', greeting: '어서 와' });
    greetings.hide();
    greetings.hide();
    expect(greetings.get()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
