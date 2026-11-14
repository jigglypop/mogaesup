import { describe, expect, it } from 'vitest';

import { melodyOf } from '../melody';
import { profileOf } from '../profile';
import { personOf } from './people';

describe('집의 가락', () => {
  it('기둥마다 한 마디, 천간과 지지의 오음으로 읽는다', () => {
    const melody = melodyOf(profileOf(personOf('noeul').birth));
    expect(melody.title).toBe('정유(丁酉)의 가락 · 치(徵)조');
    expect(melody.bpm).toBe(118);
    expect(melody.steps).toBe(16);
    expect(melody.notes.filter((note) => note.voice === 'lead')).toHaveLength(16);
    expect(melody.notes.filter((note) => note.voice === 'bass').map((note) => note.step)).toEqual([0, 4, 8, 12]);
    expect(melody.notes.every((note) => note.step + note.length <= melody.steps)).toBe(true);
    // 년주 丁卯: 화(치, 솔) 다음 목(각, 미), 그리고 한 옥타브 위의 화.
    const [stem, branch, high] = melody.notes.filter((note) => note.voice === 'lead');
    expect(stem!.hz / 523.25).toBeCloseTo(2 ** (7 / 12), 5);
    expect(branch!.hz / 523.25).toBeCloseTo(2 ** (4 / 12), 5);
    expect(high!.hz / stem!.hz).toBeCloseTo(2, 5);
  });

  it('시를 모르면 세 마디다', () => {
    const melody = melodyOf(profileOf({ ...personOf('noeul').birth, time: null }));
    expect(melody.steps).toBe(12);
    expect(melody.notes.filter((note) => note.voice === 'lead')).toHaveLength(12);
  });
});
