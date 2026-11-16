// Measures a member's 섬 (the 사주 village, the app's main page) in Chrome on this machine's GPU (WebGPU): how long the
// picture takes to show, bytes, long tasks, frames and the main thread's hottest functions while the village rests and
// while the camera is turned. Signs up throwaway members on the target server (one, and `--village=N` neighbours with
// homes of their own), with passwords made for this run.
// Usage: node scripts/perf-probe.mjs [webUrl] [outFile] [--village=N] [--allow-remote]   (a local server; it creates accounts)
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const allowRemote = args.includes('--allow-remote');
const neighbours = Number(args.find((arg) => arg.startsWith('--village='))?.slice('--village='.length) ?? 0);
const [WEB = 'http://127.0.0.1:5180', OUT] = args.filter((arg) => !arg.startsWith('--'));
const { hostname } = new URL(WEB);
if (!allowRemote && !/^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(hostname)) {
  console.error(`${WEB} is not a loopback address, and this script signs up accounts there. Pass --allow-remote to run it anyway.`);
  process.exit(1);
}
const PHASE_MS = 8_000;
/** Extra wait after the picture shows, to tell start-up hitches from steady ones. */
const SETTLE_MS = Number(process.env['PERF_SETTLE_MS'] ?? 3_000);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])],
});

/** Signs up a member in `context` and builds their home; the session stays with the context. */
async function member(context, index) {
  const page = await context.newPage();
  await page.goto(WEB);
  const username = `perf_${randomBytes(3).toString('hex')}`;
  const password = randomBytes(16).toString('hex');
  const birth = { calendar: 'solar', year: 1975 + index * 3, month: 1 + ((index * 5) % 12), day: 2 + ((index * 7) % 26), leapMonth: false, time: `${String((index * 7) % 24).padStart(2, '0')}:30`, gender: index % 2 ? 'male' : 'female' };
  const made = await page.evaluate(
    async ({ name, password, birth }) => {
      const send = (path, method, body) => fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const registered = await send('/auth/register', 'POST', { username: name, displayName: '측정', password });
      if (registered.status !== 201) return `register answered ${registered.status}`;
      const { user } = await registered.json();
      const built = await send('/homes/me/saju', 'PUT', { expectedOwnerId: user.id, name: `측정 ${name.slice(-3)}`, birth });
      return built.ok ? null : `building the home answered ${built.status}`;
    },
    { name: username, password, birth },
  );
  if (made) throw new Error(made);
  await page.close();
  return username;
}

// The neighbours first: the village around the measured home is the latest public homes.
for (let index = 0; index < neighbours; index++) {
  const context = await browser.newContext();
  await member(context, index + 1);
  await context.close();
}
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const username = await member(context, 0);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
// The island's picture is not drawn again for the run (it needs the server's image key and draws a second canvas).
await page.route('**/saju/picture', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"none","off":true}' }));
await page.addInitScript(() => {
  window.__long = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__long.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  // The canvas marks itself drawn once its first frames have asked for nothing still being made.
  const watch = new MutationObserver(() => {
    if (!document.querySelector('.mg-saju-canvas[data-drawn]')) return;
    window.__shownAt = performance.now();
    watch.disconnect();
  });
  watch.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-drawn'] });
});

await page.goto(`${WEB}/@${username}`);
await page.waitForFunction(() => window.__shownAt !== undefined, undefined, { timeout: 180_000, polling: 250 });
const load = await page.evaluate(() => ({
  shownMs: Math.round(window.__shownAt),
  longTasks: window.__long.length,
  longTaskMs: Math.round(window.__long.reduce((sum, d) => sum + d, 0)),
  longest: Math.round(Math.max(0, ...window.__long)),
}));

const resources = await page.evaluate(() => {
  const byType = {};
  for (const entry of performance.getEntriesByType('resource')) {
    const kind = entry.name.includes('/api/') ? 'api' : (entry.name.split('?')[0].split('.').pop() ?? 'other');
    const bucket = (byType[kind] ??= { count: 0, bytes: 0, cached: 0 });
    bucket.count += 1;
    // Network bytes: a request answered from the HTTP cache transfers nothing.
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
  const started = Date.now();
  await page.evaluate(() => {
    window.__probe = { frames: [], long: [] };
    const tick = (t) => {
      window.__probe.frames.push(t);
      if (window.__probe.on !== false) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__probe.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__probe.long.push(entry.duration);
    });
    window.__probe.observer.observe({ type: 'longtask', buffered: false });
  });
  await act();
  const stats = await page.evaluate(() => {
    window.__probe.on = false;
    for (const entry of window.__probe.observer.takeRecords()) window.__probe.long.push(entry.duration);
    window.__probe.observer.disconnect();
    const { frames, long } = window.__probe;
    const deltas = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
    const at = (q) => deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))] ?? 0;
    return {
      p50: +at(0.5).toFixed(2),
      p95: +at(0.95).toFixed(2),
      max: +(deltas.at(-1) ?? 0).toFixed(1),
      longTasks: long.length,
      longTaskMs: Math.round(long.reduce((sum, d) => sum + d, 0)),
      heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6),
    };
  });
  const { profile } = await cdp.send('Profiler.stop');
  const busy = busyOf(profile);
  return { label, ...stats, mainThreadMsPerSecond: Math.round(busy / ((Date.now() - started) / 1000)), hot: hottest(profile) };
}

/** The main thread's busy time across a profile, in ms. */
function busyOf(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  let busy = 0;
  profile.samples.forEach((id, index) => {
    const name = byId.get(id).callFrame.functionName;
    if (name !== '(idle)' && name !== '(program)') busy += (profile.timeDeltas[index] ?? 0) / 1000;
  });
  return busy;
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
const resting = await phase('resting', () => page.waitForTimeout(PHASE_MS));
const box = await page.locator('.mg-saju-canvas').boundingBox();
const turning = await phase('turning', async () => {
  // A slow drag across the picture, back and forth: the camera turns about what it looks at.
  const y = box.y + box.height * 0.55;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  for (let step = 0; step < 4; step++) {
    await page.mouse.move(box.x + box.width * (step % 2 ? 0.3 : 0.7), y, { steps: 60 });
    await page.waitForTimeout(PHASE_MS / 8);
  }
  await page.mouse.up();
});

const report = { web: WEB, village: neighbours, load, resources, phases: [resting, turning], errors };
console.log(JSON.stringify({ ...report, phases: report.phases.map(({ hot, ...rest }) => rest) }, null, 2));
for (const { label, hot } of report.phases) console.log(`\n# ${label} — main thread self time\n${hot.join('\n')}`);
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
await browser.close();
