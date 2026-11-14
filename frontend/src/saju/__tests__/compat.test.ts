import { describe, expect, it } from 'vitest';

import { compatOf } from '../compat';
import type { Birth } from '../engine';
import { profileOf } from '../profile';
import { sampleOf } from '../residents';

const sample = (id: string) => profileOf(sampleOf(id)!.birth);
const born = (year: number, month: number, day: number, time: string): Birth => ({ calendar: 'solar', year, month, day, leapMonth: false, time, gender: 'female' });

describe('궁합', () => {
  it('집의 오행이 상생이면 주는 쪽을 앞에 쓴다', () => {
    const forward = compatOf(sample('sol'), sample('noeul'));
    expect(forward.headline).toBe('목생화(木生火) 시너지! 서로 영감을 주는 사이');
    expect(forward.tone).toBe('flow');
    expect(forward).toMatchObject({ from: 'wood', to: 'fire' });
    // 방문하는 쪽이 바뀌어도 같은 말이고, 다리의 양 끝만 바뀐다.
    const back = compatOf(sample('noeul'), sample('sol'));
    expect(back.headline).toBe(forward.headline);
    expect(back).toMatchObject({ from: 'fire', to: 'wood' });
  });

  it('일간이 합이면 합을 먼저 말하고, 다른 관계도 적는다', () => {
    const compat = compatOf(sample('noeul'), sample('garam'));
    expect(compat.headline).toBe('정임합(丁壬合) 인연! 촛불이 밤바다를 물들이듯 마음이 통하는 사이');
    expect(compat.tone).toBe('union');
    expect(compat.notes).toEqual(['일간 정임합(丁壬合)', '일지 진유합(辰酉合)', '집 수극화(水克火)', '내게 없는 수(水)를 채워 주는 집']);
    expect(compatOf(sample('garam'), sample('noeul')).notes).toEqual([
      '일간 정임합(丁壬合)',
      '일지 진유합(辰酉合)',
      '집 수극화(水克火)',
      '내게 없는 화(火)를 채워 주는 집',
    ]);
    expect(compatOf(sample('sol'), sample('bori')).headline).toBe('갑기합(甲己合) 인연! 큰 나무와 너른 땅처럼 믿음이 자라는 사이');
  });

  it('합이 없으면 일지의 반합과 집의 관계를 적는다', () => {
    expect(compatOf(sample('sol'), sample('bori')).notes).toEqual(['일간 갑기합(甲己合)', '집 목극토(木克土)']);
    const compat = compatOf(sample('noeul'), sample('bori'));
    expect(compat.notes).toEqual(['일지 유축 반합(酉丑)', '집 화생토(火生土)']);
    expect(compat.headline).toBe('화생토(火生土) 시너지! 따뜻하게 품어 주는 사이');
  });

  it('합도 상생도 아니면 같은 기운, 반합, 상극 순으로 말한다', () => {
    const same = compatOf(sample('sol'), sample('sol'));
    expect(same.headline).toBe('같은 목(木) 기운! 나란히 숲을 이루는 사이');
    expect(same.tone).toBe('same');
    const spark = compatOf(sample('bori'), sample('garam'));
    expect(spark.headline).toBe('토극수(土克水) 자극! 둑이 물길을 잡듯 균형을 맞춰 주는 사이');
    expect(spark.tone).toBe('spark');
  });

  it('일지가 충이면 적어 두고, 없는 오행을 채워 주는 집은 조사에 맞춰 적는다', () => {
    // 1990-02-24 정오: 庚午 戊寅 庚申 壬午. 솔의 甲寅 일주와 寅申沖이고, 솔에게 없는 금이 가장 많다.
    const metal = profileOf(born(1990, 2, 24, '12:00'));
    expect(metal.reading.day.cn).toBe('庚申');
    expect(metal.balance.dominant).toBe('metal');
    const compat = compatOf(sample('sol'), metal);
    expect(compat.notes).toEqual(['일지 인신충(寅申沖)', '집 금극목(金克木)', '내게 없는 금(金)을 채워 주는 집']);
    expect(compat.headline).toBe('금극목(金克木) 자극! 가지를 다듬어 곧게 키워 주는 사이');
    expect(compatOf(metal, sample('sol')).notes).toEqual(['일지 인신충(寅申沖)', '집 금극목(金克木)', '내 금(金)이 채워 주는 집']);
  });
});
