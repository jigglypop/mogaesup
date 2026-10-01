import { describe, expect, it } from 'vitest';

import type { HomeSummary } from '../../api/types';
import { appendHomes, EXPLORE_PAGE, nextBefore, searchOf, SEARCH_MAX } from '../explore';

const home = (username: string, updatedAt = '2026-09-30T00:00:00Z'): HomeSummary => ({
  username,
  ownerName: username,
  title: `${username}의 섬`,
  statusMessage: '',
  emoji: '😊',
  updatedAt,
  total: 0,
});
const page = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => home(`user${from + index}`, `2026-09-${String(30 - from - index).padStart(2, '0')}T00:00:00Z`));

describe('둘러보기 검색어', () => {
  it('가장자리 빈칸과 제어 문자를 걷어 낸다', () => {
    expect(searchOf('  모개  ')).toBe('모개');
    expect(searchOf('모\n개')).toBe('모 개');
    expect(searchOf('\u0000\t')).toBe('');
  });

  it('서버가 받는 길이까지만 보낸다', () => {
    const long = '가'.repeat(SEARCH_MAX + 10);
    expect([...searchOf(long)]).toHaveLength(SEARCH_MAX);
    // 이모지는 글자 하나로 센다.
    expect([...searchOf('😊'.repeat(SEARCH_MAX + 5))]).toHaveLength(SEARCH_MAX);
  });
});

describe('둘러보기 다음 쪽', () => {
  it('쪽이 가득 차면 마지막 섬의 시각에서 이어 가고, 모자라면 끝이다', () => {
    const full = page(EXPLORE_PAGE);
    expect(nextBefore(full)).toBe(full[EXPLORE_PAGE - 1]?.updatedAt);
    expect(nextBefore(page(EXPLORE_PAGE - 1))).toBeNull();
    expect(nextBefore([])).toBeNull();
  });

  it('이어 붙일 때 이미 있는 섬은 한 번만 두고 순서를 지킨다', () => {
    const first = page(3);
    const next = [home('user2'), ...page(2, 3)];
    expect(appendHomes(first, next).map((item) => item.username)).toEqual(['user0', 'user1', 'user2', 'user3', 'user4']);
    expect(appendHomes([], first)).toEqual(first);
  });
});
