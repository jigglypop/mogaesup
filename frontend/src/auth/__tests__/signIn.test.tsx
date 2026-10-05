import { describe, expect, it } from 'vitest';

import { returnPath, signInPath } from '../signIn';

describe('로그인 뒤 돌아갈 곳', () => {
  const origin = 'http://mogae.test';

  it('이 사이트의 경로면 쿼리와 해시까지 그대로 돌려준다', () => {
    expect(returnPath('/@mogae/edit', origin)).toBe('/@mogae/edit');
    expect(returnPath('/admin/catalog?q=%EB%AA%A8#top', origin)).toBe('/admin/catalog?q=%EB%AA%A8#top');
  });

  it('다른 사이트, 프로토콜 상대 주소, 로그인 화면 자신은 받지 않는다', () => {
    for (const next of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'admin', '/', '/?next=%2Fadmin', '', null, undefined]) {
      expect(returnPath(next, origin)).toBeNull();
    }
  });

  it('정규화하면 다른 사이트가 되는 경로도 받지 않는다', () => {
    for (const next of ['/.//evil.example', '/%2e//evil.example', '/%2E//evil.example/a', '/x/..//evil.example/a', '/./\\evil.example', '/\t/evil.example', '/.%2f/evil.example']) {
      const path = returnPath(next, origin);
      if (path !== null) expect(new URL(path, origin).origin).toBe(origin);
      expect(path === null || !path.startsWith('//')).toBe(true);
    }
    for (const next of ['/.//evil.example', '/%2e//evil.example', '/x/..//evil.example/a', '/./\\evil.example', '/\t/evil.example']) {
      expect(returnPath(next, origin)).toBeNull();
    }
    // Dot segments that stay on this site are fine, and come back normalized.
    expect(returnPath('/x/../@mogae', origin)).toBe('/@mogae');
  });

  it('로그인 링크는 지금 있는 곳을 next로 싣고, 로그인 화면에서는 싣지 않는다', () => {
    expect(signInPath('/@mogae/edit')).toBe('/?next=%2F%40mogae%2Fedit');
    expect(signInPath('/character?tab=a')).toBe(`/?next=${encodeURIComponent('/character?tab=a')}`);
    expect(signInPath('/')).toBe('/');
  });
});
