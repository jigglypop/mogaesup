import { describe, expect, it } from 'vitest';

import { NEUTRAL_PEER } from '../../peers';
import {
  BALLOON_DESIGNS,
  balloonAccent,
  balloonOf,
  balloonTtl,
  canonicalColor,
  DEFAULT_BALLOON,
  designOfColor,
  luminance,
  PERSON_COLORS,
  readableInk,
  roomColor,
} from '../designs';

describe('말풍선 디자인 목록', () => {
  it('열두 가지이고, 아이디는 서버가 받는 꼴로 서로 다르며, 첫째가 기본인 유리다', () => {
    const ids = BALLOON_DESIGNS.map((design) => design.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    expect(ids[0]).toBe(DEFAULT_BALLOON);
    expect(DEFAULT_BALLOON).toBe('glass');
    const labels = BALLOON_DESIGNS.map((design) => design.label);
    expect(new Set(labels).size).toBe(12);
  });

  it('기본 말고는 저마다 색이 있고, 그 색은 서로와 사람마다의 여섯 색, 중립색과 모두 다르다', () => {
    expect(balloonAccent('glass')).toBeNull();
    const accents = BALLOON_DESIGNS.filter((design) => design.id !== 'glass').map((design) => design.accent!);
    expect(accents).toHaveLength(11);
    for (const accent of accents) expect(accent).toMatch(/^#[0-9a-f]{6}$/);
    const lower = accents.map((accent) => accent.toLowerCase());
    expect(new Set(lower).size).toBe(11);
    for (const taken of [...PERSON_COLORS, NEUTRAL_PEER]) expect(lower).not.toContain(taken.toLowerCase());
  });

  it('색으로 디자인을 찾고(대소문자·빈칸 무시), 모르는 색과 사람마다의 색은 기본이다', () => {
    expect(designOfColor('#4f9fd8')).toBe('cloud');
    expect(designOfColor('#4F9FD8')).toBe('cloud');
    expect(designOfColor(' #e0a800 ')).toBe('shout');
    for (const color of PERSON_COLORS) expect(designOfColor(color)).toBe('glass');
    for (const other of ['#123456', 'red', '', null, undefined, 7]) expect(designOfColor(other)).toBe('glass');
  });

  it('방에 들어가는 색은 디자인의 색이고, 기본이면 계정마다의 색이며, 받는 쪽은 그 색으로 같은 디자인을 그린다', () => {
    expect(roomColor('cloud', 'user-1')).toBe('#4f9fd8');
    for (const balloon of ['glass', undefined, 'neon']) {
      expect(PERSON_COLORS).toContain(roomColor(balloon, 'user-1'));
      expect(roomColor(balloon, 'user-1')).toBe(roomColor('glass', 'user-1'));
    }
    for (const { id } of BALLOON_DESIGNS) expect(designOfColor(roomColor(id, 'someone'))).toBe(id);
  });

  it('한 색은 어떻게 적혀 와도 한 디자인이고, 비치는 색은 디자인이 아니다', () => {
    expect(canonicalColor('#4F9FD8')).toBe('#4f9fd8');
    expect(canonicalColor('#abc')).toBe('#aabbcc');
    expect(canonicalColor('#abcf')).toBe('#aabbcc');
    expect(canonicalColor('#4f9fd8FF')).toBe('#4f9fd8');
    for (const other of ['#4f9fd880', '#abc8', '4f9fd8', '#4f9fd', 'rgb(79, 159, 216)', null, 3]) expect(canonicalColor(other)).toBeNull();
    for (const { id, accent } of BALLOON_DESIGNS.filter((design) => design.accent)) {
      for (const spelled of [accent!, accent!.toUpperCase(), `${accent}ff`, `${accent!.toUpperCase()}FF`, ` ${accent} `])
        expect(designOfColor(spelled)).toBe(id);
      expect(designOfColor(`${accent}80`)).toBe('glass');
    }
  });

  it('디자인 색에 가까운 색은 그 디자인이 아니라 기본이다(가장 가까운 것을 고르지 않는다)', () => {
    const step = (hex: string, channel: number, by: number) => {
      const digits = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
      digits[channel] = Math.min(255, Math.max(0, digits[channel]! + by));
      return `#${digits.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    };
    for (const { accent } of BALLOON_DESIGNS.filter((design) => design.accent)) {
      for (const channel of [0, 1, 2]) for (const by of [-1, 1]) {
        const near = step(accent!, channel, by);
        if (near !== accent) expect(designOfColor(near)).toBe('glass');
      }
    }
    // The four closest pairs a person's own colour makes with a design's (ΔE 12 to 15): each keeps its own answer.
    for (const [person, accent, id] of [
      ['#e89b16', '#e0a800', 'shout'],
      ['#5a8acf', '#4f9fd8', 'cloud'],
      ['#2bb3a3', '#2f9e7a', 'mint'],
      ['#8b6cf0', '#6a4de0', 'ribbon'],
    ]) {
      expect(designOfColor(person)).toBe('glass');
      expect(designOfColor(accent)).toBe(id);
    }
  });

  it('사람마다의 여섯 색·중립색·디자인 색은 어떻게 적어도 서로 겹치지 않아, 기본 말풍선인 사람이 다른 디자인으로 보일 수 없다', () => {
    const colors = [...PERSON_COLORS, NEUTRAL_PEER, ...BALLOON_DESIGNS.flatMap((design) => (design.accent ? [design.accent] : []))];
    const spelled = colors.map((color) => canonicalColor(color));
    expect(spelled).not.toContain(null);
    expect(new Set(spelled).size).toBe(colors.length);
    // Whoever talks in the default balloon joins in one of the six, and every one of them reads as the default.
    const joined = new Set<string>();
    for (let n = 0; n < 600; n++) {
      const color = roomColor('glass', `user-${n}-${'가나다라마바'.slice(0, n % 7)}`);
      joined.add(color);
      expect(designOfColor(color)).toBe('glass');
    }
    expect([...joined].sort()).toEqual([...PERSON_COLORS].sort());
  });

  it('모르는 디자인은 기본으로 읽는다', () => {
    expect(balloonOf('mint')).toBe('mint');
    for (const other of ['neon', '', undefined, null, 3]) expect(balloonOf(other)).toBe('glass');
  });

  it('긴 말일수록 오래 보이되 2.6초에서 8초 사이다', () => {
    expect(balloonTtl('')).toBe(2600);
    expect(balloonTtl('네')).toBe(2600);
    expect(balloonTtl('안녕하세요 반가워요 모두들')).toBe(1200 + 110 * 14);
    expect(balloonTtl('가'.repeat(62))).toBe(8000);
    expect(balloonTtl('가'.repeat(200))).toBe(8000);
    // Letters are counted as people see them, not in UTF-16 halves.
    expect(balloonTtl('🙂'.repeat(20))).toBe(1200 + 110 * 20);
  });

  it('밝은 색 위 이름 글자는 어둡게, 나머지는 하얗게 쓴다', () => {
    expect(luminance('#ffffff')).toBeCloseTo(1);
    expect(luminance('#000')).toBeCloseTo(0);
    expect(luminance('blue')).toBeNull();
    for (const color of PERSON_COLORS) expect(readableInk(color)).toBe('#ffffff');
    expect(readableInk(balloonAccent('shout')!)).toBe('#1d1830');
    expect(readableInk(balloonAccent('bubble')!)).toBe('#1d1830');
    expect(readableInk(balloonAccent('night')!)).toBe('#ffffff');
    expect(readableInk(NEUTRAL_PEER)).toBe('#ffffff');
  });
});
