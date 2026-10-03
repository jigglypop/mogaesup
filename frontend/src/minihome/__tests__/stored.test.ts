import { afterEach, describe, expect, it, vi } from 'vitest';

import { randomId, readStored, visitorId } from '../stored';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('이 브라우저에 남긴 설정', () => {
  afterEach(() => localStorage.clear());

  it('남긴 설정에 없는 새 설정은 기본값으로 채운다', () => {
    localStorage.setItem('minihome:scene', JSON.stringify({ quality: 'low', postProcessing: true }));
    expect(readStored('scene', { quality: 'auto', postProcessing: false, idleThrottle: true })).toEqual({
      quality: 'low',
      postProcessing: true,
      idleThrottle: true,
    });
  });

  it('기본값과 다른 종류의 값이나 깨진 값은 받지 않는다', () => {
    localStorage.setItem('minihome:scene', JSON.stringify({ quality: 3, idleThrottle: 'yes', cinematic: true }));
    expect(readStored('scene', { quality: 'auto', idleThrottle: true })).toEqual({ quality: 'auto', idleThrottle: true, cinematic: true });
    localStorage.setItem('minihome:scene', JSON.stringify(['low']));
    expect(readStored('scene', { quality: 'auto' })).toEqual({ quality: 'auto' });
    localStorage.setItem('minihome:panel', '"open"');
    expect(readStored('panel', true)).toBe(true);
    localStorage.setItem('minihome:panel', '{');
    expect(readStored('panel', false)).toBe(false);
  });
});

describe('무작위 id', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('randomUUID가 없거나 막힌 곳(보안 연결이 아닌 페이지, 오래된 Safari)에서도 만든다', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) });
    expect(randomId()).toMatch(UUID);
    vi.stubGlobal('crypto', {
      randomUUID: () => {
        throw new TypeError('crypto.randomUUID is not a function');
      },
      getRandomValues: () => {
        throw new Error('blocked');
      },
    });
    const first = randomId();
    expect(first).toMatch(UUID);
    expect(randomId()).not.toBe(first);
  });

  it('방문자 id는 한 번 만들면 다시 쓴다', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.forEach((_, index) => (bytes[index] = index * 13));
        return bytes;
      },
    });
    const id = visitorId();
    expect(id).toMatch(UUID);
    expect(visitorId()).toBe(id);
  });
});
