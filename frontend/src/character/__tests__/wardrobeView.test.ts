import { describe, expect, it } from 'vitest';

import { ApiError, isRevisionConflict } from '../api';
import type { WardrobePart, WardrobeUnavailable } from '../factory/api';
import { fitReason, reshapable, unfittedParts, wearableParts } from '../studio/wardrobe-view';

const part = (slot: string, changes: Partial<WardrobePart> = {}): WardrobePart => ({
  job_id: 'job',
  version: 'v1',
  slot,
  name: slot,
  sha256: 'sha',
  ...changes,
});

describe('입을 수 있는 파츠', () => {
  const failed = part('top', { name: '뚫는 옷', fit_check: { status: 'fail', failures: ['소매가 몸을 뚫습니다.'] } });
  const passed = part('top', { name: '맞는 옷', fit_check: { status: 'pass', failures: [] } });
  const unchecked = part('bottom');

  it('핏 검사에서 떨어진 파츠는 운영자만 입어 본다', () => {
    expect(wearableParts([failed, passed, unchecked], true)).toEqual([failed, passed, unchecked]);
    expect(wearableParts([failed, passed, unchecked], false)).toEqual([passed, unchecked]);
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
