import { elementOfHanja, type Element } from './elements';
import { pillarsOf } from './engine';
import type { Profile } from './profile';

/** 오음: the five tones the five elements sound as, with each one's step above 궁 in semitones (a major pentatonic). */
const TONES: Record<Element, { ko: string; hanja: string; semitone: number }> = {
  earth: { ko: '궁', hanja: '宮', semitone: 0 },
  metal: { ko: '상', hanja: '商', semitone: 2 },
  wood: { ko: '각', hanja: '角', semitone: 4 },
  fire: { ko: '치', hanja: '徵', semitone: 7 },
  water: { ko: '우', hanja: '羽', semitone: 9 },
};
/** How briskly each house's tune goes, in beats a minute. */
const TEMPO: Record<Element, number> = { wood: 104, fire: 118, earth: 88, metal: 98, water: 80 };
/** 궁 of the melody: C5. */
const ROOT_HZ = 523.25;
/** Steps (eighth notes) to a pillar: its stem, its branch, the stem an octave up, the branch again. */
const STEPS_PER_PILLAR = 4;

export type Note = {
  /** Which eighth note of the loop it starts on. */
  step: number;
  /** How many steps it sounds for. */
  length: number;
  hz: number;
  voice: 'lead' | 'bass';
};

export type Melody = {
  /** `정유(丁酉)의 가락 · 치(徵)조`. */
  title: string;
  bpm: number;
  /** Eighth notes in one turn of the loop. */
  steps: number;
  notes: Note[];
};

const hzOf = (element: Element, octave = 0) => ROOT_HZ * 2 ** ((TONES[element].semitone + octave * 12) / 12);

/**
 * A home's tune: the chart read aloud. Each pillar plays its stem's tone and its branch's, a bar of four eighth notes
 * to a pillar, over a bass that holds the house's own tone and answers with the day master's.
 */
export function melodyOf(profile: Profile): Melody {
  const { balance, dayMaster, reading } = profile;
  const notes: Note[] = [];
  const pillars = pillarsOf(reading);
  pillars.forEach(({ pillar }, index) => {
    const stem = elementOfHanja(pillar.wuxing[0] ?? '') ?? dayMaster.element;
    const branch = elementOfHanja(pillar.wuxing[1] ?? '') ?? stem;
    const at = index * STEPS_PER_PILLAR;
    notes.push(
      { step: at, length: 1, hz: hzOf(stem), voice: 'lead' },
      { step: at + 1, length: 1, hz: hzOf(branch), voice: 'lead' },
      { step: at + 2, length: 1, hz: hzOf(stem, 1), voice: 'lead' },
      { step: at + 3, length: 1, hz: hzOf(branch), voice: 'lead' },
      { step: at, length: 2, hz: hzOf(index % 2 === 0 ? balance.dominant : dayMaster.element, -2), voice: 'bass' },
    );
  });
  const tone = TONES[balance.dominant];
  return {
    title: `${reading.day.ko}(${reading.day.cn})의 가락 · ${tone.ko}(${tone.hanja})조`,
    bpm: TEMPO[balance.dominant],
    steps: pillars.length * STEPS_PER_PILLAR,
    notes,
  };
}
