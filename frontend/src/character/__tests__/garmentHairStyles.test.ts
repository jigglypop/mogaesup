import { describe, expect, it } from 'vitest';

import garmentStyles from '../studio/garment-styles.json';

type Design = { slot: string; name: string; brief: string; hair_length?: string };

const designs = garmentStyles.garments as Design[];
const hair = designs.filter((item) => item.slot === 'hair');
// Every hair brief ends with this sentence: one closed piece of hair on the bald head that leaves the face open.
const CLOSING =
  'Closed rounded crown with hair-coloured root backing, rear roots connected down to the nape, clear face opening with readable eyebrows, a few broad smooth clumps, no loose strands.';
// The hairstyle itself, before that sentence.
const hairstyle = (item: Design) => item.brief.slice(0, -(CLOSING.length + 1));

describe('디자인 헤어', () => {
  it('이름은 파일 전체에서 하나뿐이고 같은 디자인이 두 번 없다', () => {
    const names = designs.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(hair.map((item) => item.brief)).size).toBe(hair.length);
  });

  it('헤어마다 길이가 있고 짧은 헤어 다음에 긴 헤어가 온다', () => {
    const lengths = hair.map((item) => item.hair_length);
    for (const length of lengths) expect(['short', 'long']).toContain(length);
    expect(lengths.lastIndexOf('short')).toBeLessThan(lengths.indexOf('long'));
  });

  it('정수리는 머리색 뿌리로 닫고 맨두피를 드러내지 않으며 앞머리는 두 눈썹을 가리지 않는다', () => {
    for (const item of hair) {
      expect(item.brief.endsWith(` ${CLOSING}`), item.name).toBe(true);
      expect(hairstyle(item).replaceAll('never bare scalp', ''), item.name).not.toMatch(/scalp|bald|shaved|skin/i);
      expect(item.brief, item.name).not.toMatch(/\b(over|cover\w*|below|hid\w*) the (eyes|eyebrows)\b/i);
    }
  });

  it('머리색이 분명하고 묶는 끈은 같은 머리색이며 장식은 없다', () => {
    for (const item of hair) {
      expect(hairstyle(item), item.name).toMatch(/\b(black|brown|blonde|copper|ginger|grey|beige|pink|lavender|mint|blue)\b/i);
      if (/\bti(e|es|ed)\b/.test(item.brief)) expect(item.brief, item.name).toContain('in the same hair colour');
      expect(hairstyle(item), item.name).not.toMatch(/\b(ribbons?|bows?|clips?|pins?|beads?|scrunchies?|headbands?|barrettes?|flowers?)\b/i);
    }
  });

  it('긴 헤어는 T자로 벌린 팔에 걸리지 않게 어깨 뒤나 등으로 내려온다', () => {
    for (const item of hair.filter((value) => value.hair_length === 'long')) {
      expect(hairstyle(item), item.name).toMatch(/behind the (\w+ )?shoulders?|down the back/);
    }
  });
});
