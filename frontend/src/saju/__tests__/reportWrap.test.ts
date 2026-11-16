import { describe, expect, it } from 'vitest';

import { paragraphsOf, piecesOf, wrap, type Measure } from '../report/wrap';

/** Type of a fixed width: a syllable, a 한자 or a full-width mark is two units, anything else one. */
const measure: Measure = (text) => Array.from(text).reduce((width, character) => width + ((character.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);

const CLOSING = /^[!),.:;?\]}·…’”」』〉》】、。，．！？：；）％%~～]/;
const OPENING = /[([{‘“「『〈《【（]$/;

/** What every set of lines keeps: no line wider than the measure (unless one character is), none starting or ending
 *  in a space, none starting with a closing mark or ending with an opening one, and every character of the text. */
function expectWellSet(text: string, width: number) {
  const lines = wrap(text, width, measure);
  for (const line of lines) {
    if (Array.from(line).length > 1) expect(measure(line)).toBeLessThanOrEqual(width);
    expect(line).toBe(line.trim());
    expect(line).not.toMatch(CLOSING);
    expect(line).not.toMatch(OPENING);
  }
  expect(lines.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  return lines;
}

describe('한글 줄 나눔', () => {
  it('음절과 음절 사이에서 줄을 바꾼다', () => {
    expect(wrap('가나다라마바사', 6, measure)).toEqual(['가나다', '라마바', '사']);
    expect(wrap('오늘은 맑음', 8, measure)).toEqual(['오늘은', '맑음']);
    expect(wrap('오늘은 맑음', 7, measure)).toEqual(['오늘은', '맑음']);
    expect(wrap('오늘은 맑음', 6, measure)).toEqual(['오늘은', '맑음']);
    expect(wrap('오늘은맑음', 6, measure)).toEqual(['오늘은', '맑음']);
  });

  it('닫는 부호는 줄 머리에 오지 않고, 앞 글자와 함께 다음 줄로 간다', () => {
    expect(wrap('가나다.', 6, measure)).toEqual(['가나', '다.']);
    expect(wrap('가나다라.” 마', 8, measure)).toEqual(['가나다', '라.” 마']);
  });

  it('여는 부호는 줄 끝에 남지 않고 뒤 글자와 함께 간다', () => {
    expect(wrap('가나(다라)', 5, measure)).toEqual(['가나', '(다', '라)']);
    expect(wrap('가일(日)이', 6, measure)).toEqual(['가일', '(日)이']);
    // `그는 「` would fit the first line.
    expect(wrap('그는 「좋은 기회」라고', 7, measure)).toEqual(['그는', '「좋은', '기회」', '라고']);
  });

  it('숫자와 로마자는 통째로, 붙어 있는 음절과 함께 둔다', () => {
    expect(wrap('그 해는 2026년이다', 8, measure)).toEqual(['그 해는', '2026년이', '다']);
    expect(wrap('GPT가 썼다', 5, measure)).toEqual(['GPT가', '썼다']);
    expect(wrap('the quick brown fox', 10, measure)).toEqual(['the quick', 'brown fox']);
    expect(wrap('2027~2029년 사이', 12, measure)).toEqual(['2027~2029년', '사이']);
  });

  it('한 줄보다 긴 낱말은 글자 단위로 자르되, 닫는 부호는 다음 조각 머리에 두지 않는다', () => {
    expect(wrap('abcdefghij', 4, measure)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrap('abcde.', 5, measure)).toEqual(['abcd', 'e.']);
  });

  it('빈칸은 줄 끝에서 자리를 차지하지 않고, 이어진 공백은 하나로 친다', () => {
    expect(wrap('가나  다라\t마', 20, measure)).toEqual(['가나 다라 마']);
    expect(wrap('  가나 ', 20, measure)).toEqual(['가나']);
    expect(wrap('', 20, measure)).toEqual([]);
  });

  it('긴 풀이도 규칙을 지키며 글자를 하나도 잃지 않는다', () => {
    const text =
      '일간 무토는 넓은 들판과 산을 함께 품은 흙입니다. 겉으로는 말수가 적고 무던해 보이지만, 속으로는 "내가 지켜야 할 것"에 대한 기준이 분명합니다(산책, 정리, 요리처럼). ‘쉬는 것도 일’이라는 마음으로, 2027~2029년 사이에는 「좋은 기회」가 옵니다… GPT처럼 빠른 도구도 무기가 됩니다!';
    for (const width of [9, 10, 13, 20, 31, 46]) expectWellSet(text, width);
  });
});

describe('줄 나눔 자리', () => {
  it('부호는 제 글자에 붙고, 빈칸은 앞 조각에 붙는다', () => {
    expect(piecesOf('“행운”이 (運) 온다.')).toEqual(['“행', '운”', '이 ', '(運) ', '온', '다.']);
    expect(piecesOf('사주·자미두수')).toEqual(['사', '주·', '자', '미', '두', '수']);
    expect(piecesOf('10%의 확률')).toEqual(['10%', '의 ', '확', '률']);
  });
});

describe('문단', () => {
  it('줄마다 한 문단, 빈 줄과 앞뒤 공백은 뺀다', () => {
    expect(paragraphsOf('첫 문단\n\n  둘째 문단  \r\n셋째')).toEqual(['첫 문단', '둘째 문단', '셋째']);
    expect(paragraphsOf('  \n')).toEqual([]);
  });
});
