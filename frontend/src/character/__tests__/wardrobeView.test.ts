import { describe, expect, it } from 'vitest';

import { ApiError, isRevisionConflict } from '../api';
import type { WardrobePart, WardrobeUnavailable } from '../factory/api';
import { fitFailures, fitReason, onBody, partsOf, reshapable, unfittedParts } from '../studio/wardrobe-view';

const part = (slot: string, changes: Partial<WardrobePart> = {}): WardrobePart => ({
  job_id: 'job',
  version: 'v1',
  slot,
  name: slot,
  sha256: 'sha',
  ...changes,
});

describe('핏 검사 결과', () => {
  const failed = part('top', { name: '뚫는 옷', fit_check: { status: 'fail', failures: ['소매가 몸을 뚫습니다.', '밑단이 뜹니다.'] } });
  const passed = part('top', { name: '맞는 옷', fit_check: { status: 'pass', failures: [] } });

  it('떨어진 이유는 운영자에게만 보인다', () => {
    expect(fitFailures(failed, true)).toEqual(['소매가 몸을 뚫습니다.', '밑단이 뜹니다.']);
    expect(fitFailures(failed, false)).toEqual([]);
    expect(fitFailures(passed, true)).toEqual([]);
    expect(fitFailures(part('bottom'), true)).toEqual([]);
  });
});

describe('저장된 조합의 파츠', () => {
  const ref = (job: string, version = 'v1') => ({ job_id: job, version, sha256: `${job}-${version}` });
  const listed = (job: string, slot: string, version = 'v1') => part(slot, { job_id: job, version, sha256: `${job}-${version}` });

  it('옷장에 있는 파츠는 입히고, 없는 파츠는 슬롯으로 알린다', () => {
    const hair = listed('hair-job', 'hair'), shoes = listed('shoes-job', 'shoes');
    const { worn, missing } = partsOf({ hair: ref('hair-job'), top: ref('gone-job'), shoes: ref('shoes-job') }, ['hair', 'top', 'shoes'], [hair, shoes]);
    expect(worn).toEqual({ hair, shoes });
    expect(missing).toEqual(['top']);
  });

  it('다시 맞춰 버전이 바뀐 파츠는 같은 작업의 지금 파츠로 입힌다', () => {
    const refitted = listed('top-job', 'top', 'v2');
    expect(partsOf({ top: ref('top-job') }, ['top'], [refitted])).toEqual({ worn: { top: refitted }, missing: [] });
  });

  it('고른 슬롯 밖의 파츠는 입히지도 없다고 알리지도 않는다', () => {
    expect(partsOf({ hairFront: ref('front-job') }, [], [listed('front-job', 'hairFront')])).toEqual({ worn: {}, missing: [] });
  });
});

describe('저장된 몸 버전', () => {
  const body = { job_id: 'body-job', version: 'v3', aliases: ['v1', 'v2'] };

  it('지금 버전과 같은 모양의 이전 버전은 같은 몸이다', () => {
    expect(onBody(body, { job_id: 'body-job', version: 'v3' })).toBe(true);
    expect(onBody(body, { job_id: 'body-job', version: 'v1' })).toBe(true);
    expect(onBody(body, { job_id: 'body-job', version: 'v0' })).toBe(false);
    expect(onBody(body, { job_id: 'other-job', version: 'v1' })).toBe(false);
    expect(onBody({ job_id: 'body-job', version: 'v3' }, { job_id: 'body-job', version: 'v1' })).toBe(false);
  });
});

describe('피팅하지 못한 파츠', () => {
  const missing: WardrobeUnavailable[] = [{ job_id: 'job', version: 'v1', slot: 'top', name: '후드', reason: 'needs_anchors' }];

  it('운영자에게만 보인다', () => {
    expect(unfittedParts(missing, true)).toBe(missing);
    expect(unfittedParts(missing, false)).toEqual([]);
  });

  it('서버가 목록을 주지 않으면 비어 있다', () => {
    expect(unfittedParts(undefined, true)).toEqual([]);
  });

  it('이유 코드를 한글로 바꾸고 모르는 코드는 피팅 실패로 둔다', () => {
    expect(['needs_anchors', 'garment_fit_incomplete', 'fit_exception', 'failed', 'fit_incomplete', 'constructor'].map(fitReason)).toEqual([
      '피팅 기준점 필요',
      '피팅 미완료',
      '피팅 중 오류',
      '피팅 실패',
      '피팅 실패',
      '피팅 실패',
    ]);
  });

  it('봉인 품질 검사가 거절한 이유도 한글로 보인다', () => {
    expect(['shoes_incomplete', 'shoes_toes_exposed', 'shoes_broken', 'hat_covers_eyes', 'hair_covers_eyes',
      'hair_backing_overhang', 'torn_surface', 'holes', 'stray_geometry'].map(fitReason)).toEqual([
      '신발 일부 없음', '발가락 드러남', '신발 조각남', '모자가 눈을 가림', '머리카락이 눈을 가림', '뒷머리 판이 늘어짐',
      '표면 찢김', '구멍', '튀어나온 조각',
    ]);
  });
});

describe('옷 모양 다시 만들기', () => {
  const shell = { fit_method: 'body-shell-v1' };
  const worn = { top: part('top', shell), bottom: part('bottom', { fit_method: 'worn-extract-v1' }), shoes: part('shoes', shell) };

  it('유료 운영자에게만 몸에 맞춰 만든 상의·하의의 조절을 준다', () => {
    expect(reshapable(worn, true).map(([slot]) => slot)).toEqual(['top']);
    expect(reshapable({ ...worn, bottom: part('bottom', shell) }, true).map(([slot]) => slot)).toEqual(['top', 'bottom']);
    expect(reshapable(worn, false)).toEqual([]);
  });

  it('입은 것이 없으면 아무것도 없다', () => {
    expect(reshapable({}, true)).toEqual([]);
  });
});

describe('리비전 충돌', () => {
  it('서버가 revision_conflict로 거절한 것만 센다', () => {
    expect(isRevisionConflict(new ApiError('revision_conflict', '목록이 바뀌었습니다.', 409))).toBe(true);
    expect(isRevisionConflict(new ApiError('request_failed', '', 409))).toBe(false);
    expect(isRevisionConflict(new Error('revision_conflict'))).toBe(false);
    expect(isRevisionConflict(null)).toBe(false);
  });
});
