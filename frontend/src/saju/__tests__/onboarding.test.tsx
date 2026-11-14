import { act } from 'react';

import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount, type } from '../../__tests__/mount';
import { MY_HOME } from '../residents';
import { resetSajuStore, sajuStore } from '../store';
import { birthOfDraft, Onboarding, type Draft } from '../ui/Onboarding';

const draft = (changes: Partial<Draft> = {}): Draft => ({
  name: '가온',
  calendar: 'solar',
  year: '1990',
  month: '1',
  day: '1',
  leapMonth: false,
  time: '12:00',
  noTime: false,
  gender: 'male',
  ...changes,
});

describe('집 짓는 카드의 검사', () => {
  it('채운 카드는 생일이 된다', () => {
    expect(birthOfDraft(draft())).toEqual({ birth: { calendar: 'solar', year: 1990, month: 1, day: 1, leapMonth: false, time: '12:00', gender: 'male' } });
    expect(birthOfDraft(draft({ noTime: true, time: '' }))).toMatchObject({ birth: { time: null } });
    // 양력의 윤달 표시는 버린다.
    expect(birthOfDraft(draft({ leapMonth: true }))).toMatchObject({ birth: { leapMonth: false } });
    expect(birthOfDraft(draft({ calendar: 'lunar', year: '2020', month: '4', day: '10', leapMonth: true }))).toMatchObject({ birth: { calendar: 'lunar', leapMonth: true } });
  });

  it('빠지거나 틀린 것을 하나씩 말한다', () => {
    expect(birthOfDraft(draft({ name: '  ' }))).toEqual({ problem: '이름을 적어 주세요.' });
    expect(birthOfDraft(draft({ day: '' }))).toEqual({ problem: '생년월일을 적어 주세요.' });
    expect(birthOfDraft(draft({ gender: null }))).toEqual({ problem: '성별을 골라 주세요.' });
    expect(birthOfDraft(draft({ time: '' }))).toEqual({ problem: '태어난 시간을 적거나 모름을 골라 주세요.' });
    expect(birthOfDraft(draft({ month: '2', day: '30' }))).toEqual({ problem: '달력에 없는 날짜예요.' });
    expect(birthOfDraft(draft({ year: '2050' }))).toEqual({ problem: '아직 오지 않은 날이에요.' });
  });
});

describe('집 짓는 카드', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSajuStore();
  });
  afterEach(() => {
    localStorage.clear();
    resetSajuStore();
    vi.restoreAllMocks();
  });

  const open = (resident = sajuStore.getState().me, suggestedName = '') =>
    mount(
      <MemoryRouter initialEntries={['/saju/edit']}>
        <Routes>
          <Route path="/saju/edit" element={<Onboarding resident={resident} suggestedName={suggestedName} />} />
          <Route path="/saju" element={<p>집</p>} />
        </Routes>
      </MemoryRouter>,
    );
  const field = (container: HTMLElement, name: string) => container.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
  const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!;
  const click = (element: Element) => act(async () => (element as HTMLElement).click());
  const submit = (container: HTMLElement) => act(async () => container.querySelector('form')!.requestSubmit());

  it('빈 카드를 내면 까닭을 말하고 집은 짓지 않는다', async () => {
    const { container, unmount } = await open();
    await submit(container);
    expect(container.querySelector('[role=alert]')?.textContent).toBe('이름을 적어 주세요.');
    expect(sajuStore.getState().me).toBeNull();
    // 고치면 말이 지워진다.
    await type(field(container, 'name'), '가온');
    expect(container.querySelector('[role=alert]')).toBeNull();
    await unmount();
  });

  it('채워서 내면 집을 짓고 내 집으로 간다', async () => {
    const { container, unmount } = await open(null, '로그인한 이름이 아주 길 때');
    // 로그인한 이름을 열두 자까지 미리 적어 둔다.
    expect(field(container, 'name').value).toBe('로그인한 이름이 아주 ');
    await type(field(container, 'name'), '가온');
    await type(field(container, 'year'), '1990년');
    await type(field(container, 'month'), '1');
    await type(field(container, 'day'), '1');
    expect(field(container, 'year').value).toBe('1990');
    await type(field(container, 'time'), '12:00');
    await click(button(container, '남성'));
    await submit(container);
    expect(sajuStore.getState().me).toEqual({
      id: MY_HOME,
      name: '가온',
      sample: false,
      birth: { calendar: 'solar', year: 1990, month: 1, day: 1, leapMonth: false, time: '12:00', gender: 'male' },
    });
    expect(container.textContent).toBe('집');
    await unmount();
  });

  it('시진은 그날의 시계를 따르고, 고르면 시각이 채워진다', async () => {
    const { container, unmount } = await open();
    const branch = container.querySelector<HTMLSelectElement>('select[name=branch]')!;
    expect(branch.disabled).toBe(true);
    await type(field(container, 'year'), '1988');
    await type(field(container, 'month'), '10');
    await type(field(container, 'day'), '1');
    expect(branch.disabled).toBe(false);
    // 서머타임이던 날의 06:15는 인시다.
    await type(field(container, 'time'), '06:15');
    expect(branch.value).toBe('2');
    expect(branch.selectedOptions[0]?.textContent).toContain('인시 04:30~06:29');
    await act(async () => {
      branch.value = '6';
      branch.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(field(container, 'time').value).toBe('12:30');
    await unmount();
  });

  it('윤달은 음력이고 그 해에 윤달이 있는 달에만 고른다', async () => {
    const { container, unmount } = await open();
    const leap = () => container.querySelector('input[name=leapMonth]');
    await type(field(container, 'year'), '2020');
    await type(field(container, 'month'), '4');
    expect(leap()).toBeNull();
    await click(button(container, '음력'));
    expect(leap()).not.toBeNull();
    await type(field(container, 'month'), '5');
    expect(leap()).toBeNull();
    await unmount();
  });

  it('시간을 모르면 시각 없이 짓는다', async () => {
    const { container, unmount } = await open();
    await type(field(container, 'name'), '가온');
    await type(field(container, 'year'), '1990');
    await type(field(container, 'month'), '1');
    await type(field(container, 'day'), '1');
    await click(button(container, '여성'));
    await click(field(container, 'noTime'));
    expect(field(container, 'time').disabled).toBe(true);
    await submit(container);
    expect(sajuStore.getState().me?.birth.time).toBeNull();
    await unmount();
  });

  it('엔진이 계산하지 못하는 시각은 그 까닭을 보여 준다', async () => {
    const { container, unmount } = await open();
    await type(field(container, 'name'), '가온');
    // 1988년 5월 8일 02:00에 시계를 03:00으로 돌렸다.
    await type(field(container, 'year'), '1988');
    await type(field(container, 'month'), '5');
    await type(field(container, 'day'), '8');
    await type(field(container, 'time'), '02:30');
    await click(button(container, '여성'));
    await submit(container);
    expect(container.querySelector('[role=alert]')?.textContent).toContain('서머타임');
    expect(sajuStore.getState().me).toBeNull();
    await unmount();
  });

  it('내 정보를 고쳐 짓거나, 물어본 뒤 집을 허문다', async () => {
    sajuStore.moveIn('가온', { calendar: 'lunar', year: 2020, month: 4, day: 10, leapMonth: true, time: null, gender: 'female' });
    const { container, unmount } = await open();
    expect(field(container, 'name').value).toBe('가온');
    expect(field(container, 'year').value).toBe('2020');
    expect(field(container, 'leapMonth').checked).toBe(true);
    expect(field(container, 'noTime').checked).toBe(true);
    expect(button(container, '여성').getAttribute('aria-checked')).toBe('true');
    await type(field(container, 'name'), '가온이');
    await submit(container);
    expect(sajuStore.getState().me?.name).toBe('가온이');
    await unmount();

    const again = await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await click(button(again.container, '집 허물기'));
    expect(sajuStore.getState().me).not.toBeNull();
    confirm.mockReturnValue(true);
    await click(button(again.container, '집 허물기'));
    expect(sajuStore.getState().me).toBeNull();
    expect(again.container.textContent).toBe('집');
    await again.unmount();
  });
});
