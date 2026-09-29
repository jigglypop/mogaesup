import { fileURLToPath } from 'node:url';

import type { AtRule, Plugin as PostcssPlugin } from 'postcss';

const slash = (path: string) => path.replace(/\\/g, '/');

/** The character studio's sources, written as a page of their own. */
const STUDIO_SRC = slash(fileURLToPath(new URL('../src/character', import.meta.url)));

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
