/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { gaesupAssets } from './vite/gaesupAssets.ts';
import { studioScope } from './vite/studio.ts';

/** The Rust server (`server/`), which also upgrades `/api/rooms/*` to WebSocket. */
const SERVER = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8080';

export default defineConfig(({ mode }) => ({
  plugins: [react(), gaesupAssets()],
  css: { postcss: { plugins: [studioScope()] } },
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
    'process.env.VITE_ENABLE_BRIDGE_LOGS': JSON.stringify(''),
  },
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: {
      // The server checks Origin on writes and room upgrades; the proxy keeps the browser's.
      '/api': { target: SERVER, ws: true },
      // Catalog models copied from the character server; CloudFront serves these from S3 in production.
      '/models': { target: SERVER },
    },
  },
  build: {
    // Maps stay beside the build for local debugging; the deploy leaves them out and the bundles do not point at them.
    sourcemap: 'hidden',
    rolldownOptions: { output: { strictExecutionOrder: true } },
  },
  test: {
    environment: 'jsdom',
  },
}));
