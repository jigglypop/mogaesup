import { fileURLToPath } from 'node:url';

import type { AtRule, Plugin as PostcssPlugin } from 'postcss';
import type { Plugin } from 'vite';

const slash = (path: string) => path.replace(/\\/g, '/');

/** The character studio's frontend sources, from the gaesup-character submodule. */
export const STUDIO_SRC = slash(fileURLToPath(new URL('../../gaesup-character/frontend/src', import.meta.url)));
const STUDIO_VIEWER = `${STUDIO_SRC}/viewer.tsx`;
const APP_VIEWER = slash(fileURLToPath(new URL('../src/studio/viewer.tsx', import.meta.url)));

/**
 * The studio's screens mount inside the app as they are. Its viewer is the one module that has to speak the app's
 * gaesup-world, so wherever the studio imports it, the app's adapted copy is served instead.
 */
export function studioModules(): Plugin {
  return {
    name: 'mogaesup-studio-modules',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !slash(importer).startsWith(STUDIO_SRC) || !/(^|\/)viewer(\.tsx)?$/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && slash(resolved.id) === STUDIO_VIEWER ? APP_VIEWER : null;
    },
  };
}

/**
 * The studio's stylesheets are written for a page of their own: `:root` tokens, bare element rules. Under the app,
 * every rule is scoped to `.studio-root`, the element the studio mounts in, so none of it reaches the rest of the app.
 */
export function studioScope(): PostcssPlugin {
  return {
    postcssPlugin: 'mogaesup-studio-scope',
    Once(root) {
      const file = root.source?.input.file;
      if (!file || !slash(file).startsWith(STUDIO_SRC)) return;
      root.walkRules((rule) => {
        const parent = rule.parent;
        if (parent?.type === 'atrule' && /keyframes$/i.test((parent as AtRule).name)) return;
        rule.selectors = rule.selectors.map((selector) =>
          /^(:root|html|body)\b/.test(selector) ? selector.replace(/^(:root|html|body)/, '.studio-root') : `.studio-root ${selector}`,
        );
      });
    },
  };
}
