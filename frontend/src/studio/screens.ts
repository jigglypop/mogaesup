/**
 * `paid`: the screen's main action starts paid studio work (the server's gateway counts every studio POST that is not an
 * upload or a selection as paid), so only paid operators are offered it; the server decides every request all the same.
 */
export type Screen = { path: string; label: string; tab: string; mode?: string; paid?: boolean };
export type Section = { title: string; screens: Screen[] };

/** Each route and the studio screen (its `tab` and `mode` query) it shows. */
const MAKE: Screen[] = [
  { path: '/admin/studio/make/photo', label: '사진으로 전체 생성', tab: 'character', mode: 'photo', paid: true },
  { path: '/admin/studio/make/body', label: '기본몸', tab: 'character', mode: 'body', paid: true },
  { path: '/admin/studio/make/parts', label: '파츠', tab: 'character', mode: 'parts', paid: true },
  { path: '/admin/studio/assets/animals', label: '동물', tab: 'animals', paid: true },
  { path: '/admin/studio/assets/props', label: '기물', tab: 'props', paid: true },
  { path: '/admin/studio/assets/textures', label: '바닥 타일', tab: 'textures', paid: true },
  { path: '/admin/studio/assets/emoticons', label: '2D 이모티콘', tab: 'emoticons', paid: true },
];
const MANAGE: Screen[] = [
  { path: '/admin/studio/library', label: '에셋 라이브러리', tab: 'admin' },
  { path: '/admin/studio/prompts', label: '프롬프트', tab: 'prompts' },
];
const WORKSPACE_SCREENS = [...MAKE, ...MANAGE];

/** What the studio's menu offers: paid screens only to paid operators, and no heading without a screen under it. */
export function studioSections(paid: boolean): Section[] {
  return [
    { title: '만들기', screens: MAKE },
    { title: '관리', screens: MANAGE },
  ]
    .map((section) => ({ ...section, screens: section.screens.filter((screen) => paid || !screen.paid) }))
    .filter((section) => section.screens.length > 0);
}

/** The studio links to its own screens as `/?tab=…`; these are the app's routes for them. */
export function routeOf(href: string): string | null {
  if (!href.startsWith('/?')) return null;
  const query = new URLSearchParams(href.slice(2));
  const tab = query.get('tab');
  const mode = query.get('mode');
  const screen = WORKSPACE_SCREENS.find((item) => item.tab === tab && (!item.mode || !mode || item.mode === mode));
  if (!screen) return null;
  query.delete('tab');
  query.delete('mode');
  const rest = query.toString();
  return rest ? `${screen.path}?${rest}` : screen.path;
}

/**
 * Points a studio link at the app's route for its screen as it is clicked, before the browser follows it. Dialogs put
 * their content on the page's body, in a `.studio-root` of their own, so this listens on the document.
 */
export function retargetStudioLink(event: Pick<Event, 'target'>) {
  const anchor = event.target instanceof Element ? event.target.closest('a[href^="/?"]') : null;
  if (!anchor?.closest('.studio-root')) return;
  const route = routeOf(anchor.getAttribute('href') ?? '');
  if (route) anchor.setAttribute('href', route);
}
