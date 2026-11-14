import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Birth } from '../engine';
import { MY_HOME, SAMPLE_RESIDENTS, SEED_ENTRIES } from '../residents';
import { canErase, entriesOf, parseState, residentsOf, resetSajuStore, sajuStore } from '../store';

const KEY = 'saju:village';
const birth: Birth = { calendar: 'solar', year: 1990, month: 1, day: 1, leapMonth: false, time: '12:00', gender: 'male' };
const at = (iso: string) => new Date(iso);

describe('마을 저장소', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSajuStore();
  });
  afterEach(() => {
    localStorage.clear();
    resetSajuStore();
  });

  it('집을 짓기 전에는 샘플 주민뿐이다', () => {
    const state = sajuStore.getState();
    expect(state.me).toBeNull();
    expect(residentsOf(state.me).map((resident) => resident.id)).toEqual(SAMPLE_RESIDENTS.map((resident) => resident.id));
  });

  it('집을 지으면 이웃의 환영 글이 방명록에 남고, 이 브라우저에 저장된다', () => {
    sajuStore.moveIn('  가온  ', birth, at('2026-11-14T03:00:00Z'));
    const state = sajuStore.getState();
    expect(state.me).toEqual({ id: MY_HOME, name: '가온', birth, sample: false });
    expect(residentsOf(state.me)[0]?.id).toBe(MY_HOME);
    expect(entriesOf(state, MY_HOME).map((entry) => entry.author)).toEqual(['sol', 'noeul']);
    expect(parseState(localStorage.getItem(KEY))).toEqual(state);
  });

  it('고쳐 지어도 방명록과 다리는 그대로다', () => {
    sajuStore.moveIn('가온', birth);
    sajuStore.connect('sol');
    const before = sajuStore.getState();
    sajuStore.moveIn('가온이', { ...birth, time: null });
    const after = sajuStore.getState();
    expect(after.me?.name).toBe('가온이');
    expect(after.me?.birth.time).toBeNull();
    expect(after.entries).toEqual(before.entries);
    expect(after.bridges).toEqual(['sol']);
  });

  it('방명록은 새 글이 위에 오고, 샘플 글과 섞인다', () => {
    sajuStore.moveIn('가온', birth);
    sajuStore.write('sol', '  놀러 왔어요  ', at('2026-11-13T00:00:00Z'));
    const entries = entriesOf(sajuStore.getState(), 'sol');
    expect(entries[0]).toMatchObject({ home: 'sol', author: MY_HOME, name: '가온', body: '놀러 왔어요' });
    expect(entries).toHaveLength(SEED_ENTRIES.filter((entry) => entry.home === 'sol').length + 1);
    expect(entries.map((entry) => Date.parse(entry.at))).toEqual([...entries.map((entry) => Date.parse(entry.at))].sort((a, b) => b - a));
  });

  it('집이 없거나 빈 글이면 남기지 않고, 긴 글은 100자에서 자른다', () => {
    sajuStore.write('sol', '집 없이 쓴 글');
    expect(sajuStore.getState().entries).toEqual([]);
    sajuStore.moveIn('가온', birth);
    const before = sajuStore.getState().entries.length;
    sajuStore.write('sol', '   ');
    expect(sajuStore.getState().entries).toHaveLength(before);
    sajuStore.write('sol', '가'.repeat(150));
    expect(sajuStore.getState().entries.at(-1)?.body).toHaveLength(100);
  });

  it('내가 쓴 글과 내 방명록의 글만 지운다', () => {
    sajuStore.moveIn('가온', birth);
    sajuStore.write('sol', '내 글');
    const state = sajuStore.getState();
    const mine = state.entries.find((entry) => entry.author === MY_HOME)!;
    const welcome = state.entries.find((entry) => entry.home === MY_HOME)!;
    const seed = SEED_ENTRIES[0]!;
    expect([mine, welcome, seed].map(canErase)).toEqual([true, true, false]);
    sajuStore.erase(seed.id);
    expect(entriesOf(sajuStore.getState(), seed.home)).toContainEqual(seed);
    sajuStore.erase(mine.id);
    sajuStore.erase(welcome.id);
    expect(sajuStore.getState().entries.map((entry) => entry.id)).not.toContain(mine.id);
    expect(sajuStore.getState().entries.map((entry) => entry.id)).not.toContain(welcome.id);
  });

  it('다리는 집이 있을 때, 있는 이웃에게, 한 번만 놓는다', () => {
    sajuStore.connect('sol');
    expect(sajuStore.getState().bridges).toEqual([]);
    sajuStore.moveIn('가온', birth);
    sajuStore.connect('sol');
    sajuStore.connect('sol');
    sajuStore.connect('nobody');
    sajuStore.connect(MY_HOME);
    expect(sajuStore.getState().bridges).toEqual(['sol']);
  });

  it('집을 허물면 저장한 것이 모두 지워진다', () => {
    sajuStore.moveIn('가온', birth);
    sajuStore.write('sol', '내 글');
    sajuStore.connect('sol');
    sajuStore.moveOut();
    expect(sajuStore.getState()).toEqual({ me: null, entries: [], bridges: [] });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('바뀌면 듣는 쪽에 알린다', () => {
    let heard = 0;
    const stop = sajuStore.subscribe(() => heard++);
    sajuStore.moveIn('가온', birth);
    sajuStore.write('sol', '안녕');
    stop();
    sajuStore.write('sol', '또 안녕');
    expect(heard).toBe(2);
  });

  it('다른 탭이 바꾼 것을 따라간다', () => {
    let heard = 0;
    const stop = sajuStore.subscribe(() => heard++);
    localStorage.setItem(KEY, JSON.stringify({ me: { name: '다른 탭', birth }, entries: [], bridges: ['garam'] }));
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(sajuStore.getState().me?.name).toBe('다른 탭');
    expect(sajuStore.getState().bridges).toEqual(['garam']);
    window.dispatchEvent(new StorageEvent('storage', { key: 'mogaesup.theme' }));
    expect(heard).toBe(1);
    stop();
  });
});

describe('저장된 값 읽기', () => {
  const stored = (changes: Record<string, unknown> = {}) => JSON.stringify({ me: { name: '가온', birth }, entries: [], bridges: [], ...changes });

  it('모양이 다른 것은 빈 마을로 읽는다', () => {
    const empty = { me: null, entries: [], bridges: [] };
    expect(parseState(null)).toEqual(empty);
    expect(parseState('{')).toEqual(empty);
    expect(parseState('[]')).toEqual(empty);
    expect(parseState(stored({ me: { name: '', birth } }))).toEqual(empty);
    expect(parseState(stored({ me: { name: '가온', birth: { ...birth, month: 13 } } }))).toEqual(empty);
    expect(parseState(stored({ me: { name: '가온', birth: { ...birth, time: '25:00' } } }))).toEqual(empty);
    expect(parseState(stored({ me: { name: '가온', birth: { ...birth, gender: 'x' } } }))).toEqual(empty);
    expect(parseState(stored({ me: { name: '가온', birth: { ...birth, year: 2050 } } }))).toEqual(empty);
  });

  it('집은 읽고, 틀린 글과 모르는 이웃의 다리는 뺀다', () => {
    const good = { id: 'a', home: 'sol', author: MY_HOME, name: '가온', body: '안녕', at: '2026-11-13T00:00:00.000Z' };
    const state = parseState(
      stored({
        me: { name: '가온이라는아주아주긴이름입니다', birth: { ...birth, leapMonth: true } },
        entries: [good, { ...good, id: 'b', body: '가'.repeat(101) }, { ...good, id: 'c', at: '언젠가' }, { ...good, id: '' }, 'x'],
        bridges: ['sol', 'sol', 'nobody', 3],
      }),
    );
    expect(state.me?.name).toBe('가온이라는아주아주긴이름');
    // 양력 생일의 윤달 표시는 뜻이 없다.
    expect(state.me?.birth.leapMonth).toBe(false);
    expect(state.entries).toEqual([good]);
    expect(state.bridges).toEqual(['sol']);
  });
});
