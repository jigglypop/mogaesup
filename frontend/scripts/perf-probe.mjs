// Measures a minihome in Chrome on this machine's GPU (WebGPU, vsync off): load time, bytes, frame times standing and
// walking, long tasks, and the main thread's hottest functions. Signs up a throwaway account on the target server.
// Usage: node scripts/perf-probe.mjs [webUrl] [outFile]   (a local server; it creates an account)
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { chromium } from 'playwright';

const WEB = process.argv[2] ?? 'http://127.0.0.1:5180';
const OUT = process.argv[3];
const PHASE_MS = 8_000;
/** Extra wait after the island is ready, to tell start-up hitches from steady ones. */
const SETTLE_MS = Number(process.env['PERF_SETTLE_MS'] ?? 0);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11', '--enable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
// PERF_IDLE=off measures without the minihome's idle frame-rate throttle (the 절전 모드 setting).
if (process.env['PERF_IDLE'] === 'off') {
  await page.addInitScript(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('minihome:scene') ?? '{}');
      localStorage.setItem('minihome:scene', JSON.stringify({ quality: 'auto', postProcessing: false, ...saved, idleThrottle: false }));
    } catch {}
  });
}
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const username = `perf_${randomBytes(3).toString('hex')}`;
await page.goto(WEB);
const registered = await page.evaluate(async (name) => {
  const response = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, displayName: '측정', password: 'perf-probe-password' }),
  });
  return response.status;
}, username);
if (registered !== 201) throw new Error(`register answered ${registered}`);

const started = Date.now();
await page.goto(`${WEB}/@${username}`);
await page.locator('.mg-world-loading.is-done').waitFor({ state: 'attached', timeout: 180_000 });
const worldReadyMs = Date.now() - started;

const resources = await page.evaluate(() => {
  const byType = {};
  for (const entry of performance.getEntriesByType('resource')) {
    const kind = entry.name.includes('/api/') ? 'api' : (entry.name.split('?')[0].split('.').pop() ?? 'other');
    const bucket = (byType[kind] ??= { count: 0, bytes: 0, cached: 0 });
    bucket.count += 1;
    // Network bytes: a request answered from the HTTP cache (a prefetched model, say) transfers nothing.
    bucket.bytes += entry.transferSize;
    if (entry.transferSize === 0 && entry.encodedBodySize > 0) bucket.cached += 1;
  }
  return byType;
});

const cdp = await context.newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });

async function phase(label, act) {
  // Starting the profiler pauses V8 for a few hundred ms; frames are counted only after that.
  await cdp.send('Profiler.start');
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__probe = { frames: [], long: [] };
    const tick = (t) => {
      window.__probe.frames.push(t);
      if (window.__probe.on !== false) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__probe.long.push(entry.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
  await act();
  const stats = await page.evaluate(() => {
    window.__probe.on = false;
    const { frames, long } = window.__probe;
    const deltas = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
    const at = (q) => deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))] ?? 0;
    const mean = deltas.reduce((sum, d) => sum + d, 0) / Math.max(1, deltas.length);
    return {
      fps: Math.round(1000 / mean),
      p50: +at(0.5).toFixed(2),
      p95: +at(0.95).toFixed(2),
      p99: +at(0.99).toFixed(2),
      max: +(deltas.at(-1) ?? 0).toFixed(1),
      longTasks: long.length,
      longTaskMs: Math.round(long.reduce((sum, d) => sum + d, 0)),
      heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6),
    };
  });
  const { profile } = await cdp.send('Profiler.stop');
  return { label, ...stats, hot: hottest(profile) };
}

/** Self time per function across the profile, highest first. */
function hottest(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const interval = (profile.endTime - profile.startTime) / Math.max(1, profile.samples.length);
  for (const id of profile.samples) {
    const { callFrame } = byId.get(id);
    const file = callFrame.url.split('/').pop()?.split('?')[0] || '(native)';
    const key = `${callFrame.functionName || '(anonymous)'} ${file}:${callFrame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + interval);
  }
  const total = [...self.values()].reduce((sum, v) => sum + v, 0);
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([key, us]) => `${((100 * us) / total).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(6)}ms  ${key}`);
}

await page.waitForTimeout(SETTLE_MS);
// The performance report sits behind the settings menu; it stays open, as the old side panel did.
await page.getByRole('button', { name: '화면 설정' }).click().catch(() => {});
await page.getByRole('button', { name: '성능 보기' }).click().catch(() => {});
const renderer = await page.locator('.mh-status').innerText().catch(() => '');
const standing = await phase('standing', () => page.waitForTimeout(PHASE_MS));
await page.locator('.mg-world-canvas canvas').click({ position: { x: 300, y: 300 } }).catch(() => {});
const walking = await phase('walking', async () => {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(PHASE_MS / 2);
  await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(PHASE_MS / 2);
  await page.keyboard.up('KeyD');
});

const report = {
  web: WEB,
  worldReadyMs,
  resources,
  renderer: renderer.replace(/\s+/g, ' ').slice(0, 600),
  phases: [standing, walking],
  errors,
};
console.log(JSON.stringify({ ...report, phases: report.phases.map(({ hot, ...rest }) => rest) }, null, 2));
for (const { label, hot } of report.phases) console.log(`\n# ${label} — main thread self time\n${hot.join('\n')}`);
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
await browser.close();
