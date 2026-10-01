import { describe, expect, it } from 'vitest';

import type { PartMethod } from '../factory/api';
import { fitProfileFor, fitsByPrompt, type FitChoices } from '../studio/garment-fit';

const chosen: FitChoices = { sleeve: 'long', kind: 'skirt', ease: 'loose' };
const untouched: FitChoices = { sleeve: 'source', kind: 'source', ease: 'source' };

describe('옷의 소매·여유·하의 종류', () => {
  it('소매와 여유는 단독 3D 생성에서만 묻는다', () => {
    expect(fitsByPrompt('isolated')).toBe(true);
    for (const method of ['worn', 'body_shell'] as PartMethod[]) expect(fitsByPrompt(method)).toBe(false);
  });

  it('단독 3D 생성은 고른 소매와 여유를 보낸다', () => {
    expect(fitProfileFor('top', 'isolated', chosen)).toEqual({ revision: 'garment-fit-v1', sleeve: 'long', ease: 'loose' });
    expect(fitProfileFor('bottom', 'isolated', chosen)).toEqual({ revision: 'garment-fit-v1', kind: 'skirt', ease: 'loose' });
  });

  it('입힌 채·몸에 맞춰 만들 때는 골라 둔 값이 남아 있어도 기본값만 보낸다', () => {
    for (const method of ['worn', 'body_shell'] as PartMethod[]) {
      expect(fitProfileFor('top', method, chosen)).toEqual({ revision: 'garment-fit-v1', sleeve: 'source', ease: 'source' });
      expect(fitProfileFor('top', method, chosen)).toEqual(fitProfileFor('top', method, untouched));
    }
  });

  it('하의 종류는 어느 방식에서나 보낸다', () => {
    for (const method of ['isolated', 'worn', 'body_shell'] as PartMethod[]) {
      expect(fitProfileFor('bottom', method, chosen)).toMatchObject({ kind: 'skirt' });
    }
    expect(fitProfileFor('bottom', 'worn', chosen)).toEqual({ revision: 'garment-fit-v1', kind: 'skirt', ease: 'source' });
  });

  it('상의·하의가 아닌 파츠에는 핏이 없다', () => {
    for (const slot of ['hair', 'hat', 'shoes', 'weapon']) expect(fitProfileFor(slot, 'isolated', chosen)).toBeUndefined();
  });
});
