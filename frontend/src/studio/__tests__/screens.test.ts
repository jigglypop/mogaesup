import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rememberStudioQuery, retargetStudioLink, routeOf, studioHref, studioSections } from '../screens';

describe('캐릭터 공장 메뉴', () => {
  it('유료 작업자에게는 모든 화면을 보여 준다', () => {
    const sections = studioSections(true);
    expect(sections.map((section) => section.title)).toEqual(['만들기', '관리']);
    expect(sections[0]?.screens.map((screen) => screen.label)).toEqual([
      '사진으로 전체 생성',
      '기본몸',
      '파츠',
      '동물',
      '기물',
      '바닥 타일',
      '2D 이모티콘',
    ]);
  });

  it('만들기 화면은 모두 유료 작업을 시작하므로 유료가 아닌 운영자에게는 보이지 않는다', () => {
    expect(studioSections(true)[0]?.screens.every((screen) => screen.paid)).toBe(true);
    const sections = studioSections(false);
    expect(sections.map((section) => section.title)).toEqual(['관리']);
    expect(sections[0]?.screens.map((screen) => screen.path)).toEqual(['/admin/studio/library', '/admin/studio/prompts']);
    expect(sections.flatMap((section) => section.screens).some((screen) => screen.paid)).toBe(false);
  });
});

describe('스튜디오 화면 주소', () => {
  it('클릭하기 전부터 앱 경로를 만들고 선택한 작업과 파츠를 보존한다', () => {
    expect(studioHref({ tab: 'prompts', promptGroup: 'expression' })).toBe('/admin/studio/prompts?promptGroup=expression');
    const body = new URL(studioHref({ tab: 'character', mode: 'body', partsJob: 'saved version' }), location.origin);
    expect(body.pathname).toBe('/admin/studio/make/body');
    expect(body.searchParams.get('partsJob')).toBe('saved version');
    const part = new URL(studioHref({ tab: 'character', mode: 'parts', base: 'job&base', partsJob: 'saved-v2', part: 'top' }), location.origin);
    expect(part.pathname).toBe('/admin/studio/make/parts');
    expect(part.searchParams.get('base')).toBe('job&base');
    expect(part.searchParams.get('partsJob')).toBe('saved-v2');
    expect(part.searchParams.get('part')).toBe('top');
    const photo = new URL(studioHref({ tab: 'character', mode: 'photo', photoJob: 'model-v3', photoCharacter: 'character1' }), location.origin);
    expect(photo.pathname).toBe('/admin/studio/make/photo');
    expect(photo.searchParams.get('photoJob')).toBe('model-v3');
    expect(photo.searchParams.get('photoCharacter')).toBe('character1');
  });

  it('선택 쿼리만 갱신하면 현재 화면의 pathname을 사용한다', () => {
    expect(studioHref({ photoJob: 'v2' }, '/admin/studio/make/photo')).toBe('/admin/studio/make/photo?photoJob=v2');
    expect(studioHref({ asset: 'v2', slot: 'hair' }, '/admin/studio/library')).toBe('/admin/studio/library?asset=v2&slot=hair');
    expect(() => studioHref({ tab: 'nothing' })).toThrow();
  });

  it('주소에 선택을 기억할 때 라우터 상태와 hash를 보존한다', () => {
    const previous = `${location.pathname}${location.search}${location.hash}`;
    const state = history.state;
    try {
      history.replaceState({ key: 'router-key', idx: 3 }, '', '/admin/studio/make/photo#selected');
      rememberStudioQuery(new URLSearchParams({ tab: 'character', mode: 'photo', photoJob: 'generated-v2' }));
      expect(location.pathname).toBe('/admin/studio/make/photo');
      expect(new URLSearchParams(location.search).get('photoJob')).toBe('generated-v2');
      expect(location.hash).toBe('#selected');
      expect(history.state).toEqual({ key: 'router-key', idx: 3 });
    } finally { history.replaceState(state, '', previous); }
  });

  it('스튜디오가 쓰는 /?tab 주소를 앱의 경로로 바꾼다', () => {
    expect(routeOf('/?tab=prompts&promptGroup=parts')).toBe('/admin/studio/prompts?promptGroup=parts');
    expect(routeOf('/?tab=character&mode=parts&base=job1&part=top')).toBe('/admin/studio/make/parts?base=job1&part=top');
    expect(routeOf('/?tab=character&mode=body&partsJob=job2')).toBe('/admin/studio/make/body?partsJob=job2');
    expect(routeOf('/?tab=textures')).toBe('/admin/studio/assets/textures');
  });

  it('모르는 주소는 그대로 둔다', () => {
    expect(routeOf('/?tab=nothing')).toBeNull();
    expect(routeOf('/admin/studio/library')).toBeNull();
    expect(routeOf('https://example.com/?tab=prompts')).toBeNull();
  });
});

describe('스튜디오 링크 눌림', () => {
  beforeEach(() => {
    document.addEventListener('click', retargetStudioLink, true);
    // jsdom cannot navigate; the click only has to reach the end.
    document.addEventListener('click', stop);
  });
  afterEach(() => {
    document.removeEventListener('click', retargetStudioLink, true);
    document.removeEventListener('click', stop);
    document.body.replaceChildren();
  });
  const stop = (event: Event) => event.preventDefault();
  const link = (href: string, parent: Element) => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);
    anchor.textContent = '열기';
    parent.append(anchor);
    return anchor;
  };
  const press = (element: Element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  it('무대 안의 링크를 누르면 앱의 경로로 바뀐다', () => {
    const stage = document.body.appendChild(document.createElement('div'));
    stage.className = 'studio-root';
    const anchor = link('/?tab=prompts&promptGroup=parts', stage);
    press(anchor);
    expect(anchor.getAttribute('href')).toBe('/admin/studio/prompts?promptGroup=parts');
  });

  it('body에 따로 올라간 대화상자 안의 링크도 바뀐다', () => {
    const dialogRoot = document.body.appendChild(document.createElement('div'));
    dialogRoot.className = 'studio-root';
    const dialog = dialogRoot.appendChild(document.createElement('dialog'));
    const anchor = link('/?tab=character&mode=parts&base=job1&part=top', dialog);
    const inner = anchor.appendChild(document.createElement('b'));
    press(inner);
    expect(anchor.getAttribute('href')).toBe('/admin/studio/make/parts?base=job1&part=top');
  });

  it('스튜디오 밖의 링크와 모르는 링크는 건드리지 않는다', () => {
    const outside = link('/?tab=prompts', document.body);
    press(outside);
    expect(outside.getAttribute('href')).toBe('/?tab=prompts');
    const stage = document.body.appendChild(document.createElement('div'));
    stage.className = 'studio-root';
    const unknown = link('/?tab=nothing', stage);
    const plain = link('/@mogae', stage);
    press(unknown);
    press(plain);
    expect(unknown.getAttribute('href')).toBe('/?tab=nothing');
    expect(plain.getAttribute('href')).toBe('/@mogae');
  });
});
