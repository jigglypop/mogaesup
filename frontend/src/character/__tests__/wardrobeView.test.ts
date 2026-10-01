import { describe, expect, it } from 'vitest';

import { ApiError, isRevisionConflict } from '../api';
import type { WardrobePart } from '../factory/api';
import { reshapable, wearableParts } from '../studio/wardrobe-view';

const part = (slot: string, changes: Partial<WardrobePart> = {}): WardrobePart => ({
  job_id: 'job',
  version: 'v1',
  slot,
  name: slot,
  sha256: 'sha',
  ...changes,
});

describe('옷장 목록', () => {
  const good = part('top', { name: '좋은 옷', fit_check: { status: 'pass', failures: [] } });
  const unchecked = part('top', { name: '검사 전', fit_check: null });
  const bad = part('top', { name: '맞지 않는 옷', fit_check: { status: 'fail', failures: ['소매가 몸을 뚫습니다.'] } });
  const parts = [good, unchecked, bad];

  it('운영자가 아니면 핏 검사에서 떨어진 파츠를 보지 못한다', () => {
    expect(wearableParts(parts, false).map((item) => item.name)).toEqual(['좋은 옷', '검사 전']);
  });

  it('운영자는 떨어진 파츠도 본다', () => {
    expect(wearableParts(parts, true)).toBe(parts);
  });

  it('검사 기록이 없는 파츠는 입을 수 있다', () => {
    expect(wearableParts([part('hat'), part('shoes', { fit_check: undefined })], false)).toHaveLength(2);
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
