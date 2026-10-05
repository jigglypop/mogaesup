import { fileURLToPath } from 'node:url';

import type { AtRule, Plugin as PostcssPlugin } from 'postcss';

/**
 * A path to compare by: forward slashes, and on Windows lower case, since there one file can arrive as `C:\dev\…` from
 * this module and as `c:/dev/…` from the bundler (the drive letter follows how the shell spelled the folder).
 */
const comparable = (path: string, platform: string) => {
  const forward = path.replace(/\\/g, '/');
  return platform === 'win32' ? forward.toLowerCase() : forward;
};

/** The character studio's sources, written as a page of their own; the slash keeps a sibling like `character-x` out. */
const STUDIO_SRC = `${fileURLToPath(new URL('../src/character', import.meta.url))}/`;

/** Whether `file` is one of the studio's own sources (`platform` is for tests). */
export function isStudioFile(file: string, platform: string = process.platform) {
  return comparable(file, platform).startsWith(comparable(STUDIO_SRC, platform));
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
      if (!file || !isStudioFile(file)) return;
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
