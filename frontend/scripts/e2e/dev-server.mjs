// The app's dev server for scripts/character-e2e.mjs, in a process of its own so its native bundler never takes the test
// down with it: on `port`, against the Rust server at SERVER_URL (read by vite.config.ts), with its own dependency cache
// (the dev server on 5180 keeps its own), neither watching files nor reloading pages. It stops when its stdin closes,
// that is, when the process that started it goes.
// Usage: SERVER_URL=http://127.0.0.1:<port> node scripts/e2e/dev-server.mjs <port>
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const server = await createServer({
  root: FRONTEND,
  configFile: join(FRONTEND, 'vite.config.ts'),
  cacheDir: join(FRONTEND, 'node_modules/.vite-character-e2e'),
  logLevel: 'error',
  clearScreen: false,
  server: { port: Number(process.argv[2]), strictPort: true, host: '127.0.0.1', hmr: false, watch: null },
  // Bundled afresh each run: a cache left from an older gaesup-world served its old exports after an upgrade.
  optimizeDeps: { entries: ['index.html', 'src/**/*.{ts,tsx}', '!src/**/__tests__/**'], force: true },
});
await server.listen();
process.stdin.once('end', () => void server.close().finally(() => process.exit()));
process.stdin.resume();
