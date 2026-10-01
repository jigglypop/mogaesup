import { describe, expect, it } from 'vitest';

import { NEUTRAL_PEER, peerColor } from '../peers';

describe('방에 있는 사람의 색', () => {
  it('16진수 색은 그대로 쓴다', () => {
    for (const color of ['#fff', '#ff7a59', '#FF7A59', '#ff7a5980', '#abcd']) expect(peerColor(color)).toBe(color);
  });

  it('색이 아닌 값은 무채색으로 바꾼다', () => {
    const bad = [
      'red',
      'url(https://example.com/pixel.png)',
      '#ff7a59; background: url(x)',
      '#ff7a59\n',
      '#ff',
      '#ff7a59801',
      'ff7a59',
      'rgb(1, 2, 3)',
      '',
    ];
    for (const color of bad) expect(peerColor(color)).toBe(NEUTRAL_PEER);
    for (const color of [undefined, null, 12, {}]) expect(peerColor(color)).toBe(NEUTRAL_PEER);
  });
});
