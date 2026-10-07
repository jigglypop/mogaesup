// End-to-end check of the island's games in Chrome, without spending money: 카트 and 임포스터 take the island's place
// while they play, every racer drives a kart, and touch screens get the kart's buttons and a walking pad. It builds and
// starts the Rust server (server/) on a throwaway database and this app's dev server (scripts/e2e/dev-server.mjs) in
// front, both on spare ports and in processes of their own (no character server: none is needed). Then:
// - desktop: a race on the racing island (keys drive and steer the physics body), and back to where the racer stood;
// - phone (844×390 and 390×844, touch): the walking pad on the island, the kart's buttons held by several fingers at
//   once, let go by a lifted finger, a cancelled touch and a lost focus, and back home;
// - 임포스터 on desktop and phone: the ship at the island's ground, walked by keys and by the pad, and back home;
// - someone watching a race on another's island: sent to the stand (the live room takes the jump), and home again.
// Screenshots of each go to the folder given (.data/games-e2e by default). Whatever happens, it stops what it started
// and drops its database; what a run killed outright leaves, the next run removes.
// Usage: node scripts/kart-e2e.mjs [screenshotDir] [--skip-build] [--only kart|impostor|watch]
//        (needs the local PostgreSQL at 127.0.0.1:55432, cargo and Chrome; CARGO_TARGET_DIR is honoured)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createListener } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { sql } from './e2e/pg.mjs';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(FRONTEND, '..');
const SERVER_DIR = join(ROOT, 'server');
const argv = process.argv.slice(2);
const options = { only: null, skipBuild: false, shots: null };
for (let at = 0; at < argv.length; at++) {
  const value = argv[at];
  if (value === '--skip-build') options.skipBuild = true;
  else if (value === '--only') options.only = argv[++at];
  else if (!value.startsWith('--') && !options.shots) options.shots = value;
  else throw new Error(`unknown argument ${value}`);
}
const SHOTS = resolve(options.shots ?? join(ROOT, '.data/games-e2e'));
const POSTGRES = `postgres://postgres:${process.env['POSTGRES_PASSWORD'] ?? 'postgres-dev'}@127.0.0.1:55432`;
const SCREENSHOT = { timeout: 90_000, animations: 'disabled' };
const WORLD_READY_MS = 120_000;
/** Where the stand beside the start is (frontend/src/games/kart/track.ts STAND), and how far round it watchers stand. */
const KART_STAND = [-56, 0, 109.5];
const STAND_REACH = 2.5;
const began = Date.now();
const problems = [];
const evidence = { steps: [] };

mkdirSync(SHOTS, { recursive: true });

// Undone in reverse order at the end, on Ctrl+C too.
const cleanups = [];
let cleaning = null;
const cleanup = () =>
  (cleaning ??= (async () => {
    for (const undo of cleanups.reverse())
      await Promise.resolve()
        .then(undo)
        .catch((error) => console.log(`cleanup: ${error.message}`));
  })());
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void cleanup().finally(() => process.exit(130)));
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.once(event, (error) => {
    console.error(error);
    void cleanup().finally(() => process.exit(1));
  });
}
process.stdout.on('error', () => {});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const firstLine = (error) => String(error?.message ?? error).split('\n')[0];
const freePort = () =>
  new Promise((done, fail) => {
    const probe = createListener().once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
const stop = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((done) => {
        child.once('exit', done);
        child.kill();
        setTimeout(done, 5000);
      });
function run(command, args, runOptions) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { ...runOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    cleanups.push(() => stop(child));
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.once('error', fail);
    child.once('exit', (code) => (code === 0 ? done(output) : fail(new Error(`${command} ${args.join(' ')} failed (${code}):\n${output.slice(-4000)}`))));
  });
}
async function until(check, timeout, what) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline; await sleep(100)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`${what}: not within ${timeout / 1000}s`);
}
async function step(label, work) {
  const started = Date.now();
  try {
    const value = await work();
    evidence.steps.push({ label, passed: true, ms: Date.now() - started });
    console.log(`ok   ${label} (${Date.now() - started}ms)`);
    return value ?? true;
  } catch (error) {
    evidence.steps.push({ label, passed: false, error: String(error?.message ?? error) });
    problems.push(`${label}: ${firstLine(error)}`);
    console.log(`FAIL ${label}: ${firstLine(error)}`);
    return null;
  }
}
const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const watch = (child, name) => {
  cleanups.push(() => stop(child));
  child.once('exit', (code) => cleaning || problems.push(`${name} exited (${code})`));
  return child;
};

let WEB = '';
let browser;

async function setup() {
  const work = mkdtempSync(join(tmpdir(), `mogaesup-games-e2e-${process.pid}-`));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  for (const name of readdirSync(tmpdir())) {
    const pid = Number(/^mogaesup-games-e2e-(\d+)-/.exec(name)?.[1]);
    if (pid && !running(pid)) rmSync(join(tmpdir(), name), { recursive: true, force: true, maxRetries: 2 });
  }
  const exe = process.platform === 'win32' ? 'mogaesup-server.exe' : 'mogaesup-server';
  if (!options.skipBuild) await run('cargo', ['build', '--quiet'], { cwd: SERVER_DIR });
  // A copy runs, so cargo can build and test while this runs.
  copyFileSync(join(resolve(SERVER_DIR, process.env['CARGO_TARGET_DIR'] ?? 'target'), 'debug', exe), join(work, exe));

  const database = `mogaesup_e2e_${process.pid}_${randomBytes(3).toString('hex')}`;
  const admin = `${POSTGRES}/postgres`;
  const listed = await sql(admin, "SELECT datname FROM pg_database WHERE datname LIKE 'mogaesup\\_e2e\\_%'");
  for (const [name] of listed) {
    const pid = Number(/^mogaesup_e2e_(\d+)_/.exec(name)?.[1]);
    if (pid && !running(pid)) await sql(admin, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
  await sql(admin, `CREATE DATABASE ${database}`);
  cleanups.push(() => sql(admin, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`));

  const [apiPort, webPort] = [await freePort(), await freePort()];
  const API = `http://127.0.0.1:${apiPort}`;
  WEB = `http://127.0.0.1:${webPort}`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(FACTORY_|BOOTSTRAP_|AWS_|STUDIO_)/.test(key)) delete env[key];
  Object.assign(env, {
    DATABASE_URL: `${POSTGRES}/${database}`,
    LISTEN_ADDR: `127.0.0.1:${apiPort}`,
    APP_ORIGIN: WEB,
    COOKIE_SECURE: 'false',
    REALTIME_TICKET_SECRET: randomBytes(36).toString('base64'),
    MODEL_STORE: join(work, 'models'),
    RUST_LOG: 'info',
    NO_COLOR: '1',
  });
  const log = createWriteStream(join(work, 'server.log'));
  cleanups.push(() => new Promise((done) => log.end(done)));
  const server = watch(spawn(join(work, exe), [], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env }), 'Rust server');
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  const answers = (url, child, what) =>
    until(
      async () => {
        if (child.exitCode !== null) throw new Error(`${what} exited (${child.exitCode})`);
        return fetch(url).then(
          (response) => response.ok,
          () => false,
        );
      },
      60_000,
      what,
    );
  await answers(`${API}/api/health`, server, 'the Rust server');
  const vite = watch(
    spawn(process.execPath, [join(FRONTEND, 'scripts/e2e/dev-server.mjs'), String(webPort), 'games'], {
      cwd: FRONTEND,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, SERVER_URL: API },
    }),
    'web dev server',
  );
  await answers(WEB, vite, 'the web dev server');
  browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-webgpu', '--enable-gpu', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])] });
  cleanups.push(() => browser.close());
  console.log(`ok   isolated Rust/Vite ready at ${WEB}`);
}

const PHONE = { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1600, height: 900 } };

/**
 * Someone in a browser of their own: signed up with an island, the frames their page sends and gets kept (their own
 * place in the live room as their page says it, the session their game socket is shown, the others' places as the room
 * relays them), and their page errors counted as problems.
 */
async function person(kind, device = DESKTOP) {
  const context = await browser.newContext(device);
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['data:', 'blob:'].includes(url.protocol) || url.origin === WEB ? route.continue() : route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  const me = { kind, page, context, pose: null, session: null, peer: null, relayed: new Map() };
  page.on('pageerror', (error) => problems.push(`${kind} pageerror: ${firstLine(error)}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|DevTools|Failed to load resource/.test(message.text())) problems.push(`${kind} console: ${message.text().slice(0, 250)}`);
  });
  await page.addInitScript(() => {
    window.__pointers = [];
    window.__focus = [];
    for (const type of ['focus', 'blur', 'visibilitychange'])
      window.addEventListener(type, (event) => window.__focus.push({ type, trusted: event.isTrusted, window: event.target === window, hidden: document.hidden, focused: document.hasFocus() }), true);
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture'])
      window.addEventListener(
        type,
        (event) => {
          const button = event.target instanceof Element ? event.target.closest('.mg-kart-control, .mg-walking-control') : null;
          if (button) window.__pointers.push({ type, control: button.getAttribute('data-control') ?? button.getAttribute('data-direction'), id: event.pointerId, trusted: event.isTrusted });
        },
        true,
      );
  });
  page.on('websocket', (socket) => {
    const parse = (payload) => {
      try {
        return JSON.parse(String(payload));
      } catch {
        return null;
      }
    };
    if (socket.url().includes('/api/rooms/')) {
      socket.on('framesent', ({ payload }) => {
        const message = parse(payload);
        if (message?.type !== 'Update') return;
        me.pose = { ...(me.pose ?? {}), ...(message.state ?? {}), at: Date.now() };
      });
      socket.on('framereceived', ({ payload }) => {
        const message = parse(payload);
        if (message?.type === 'Welcome') me.peer = message.client_id;
        if (message?.type === 'PlayerUpdate' && message.state?.position) me.relayed.set(message.client_id, { position: message.state.position, at: Date.now() });
      });
    }
    if (socket.url().includes('/api/games/'))
      socket.on('framereceived', ({ payload }) => {
        const message = parse(payload);
        if (message?.type === 'Session') me.session = message.session;
        if (message?.type === 'Error') problems.push(`${kind} game: ${message.code} ${message.message}`);
      });
  });
  me.username = `g${kind.replace(/[^a-z]/g, '').slice(0, 6)}_${randomBytes(3).toString('hex')}`;
  await page.goto(WEB);
  await page.getByRole('tab', { name: '가입하기' }).click();
  await page.locator('input[name=username]').fill(me.username);
  await page.locator('input[name=displayName]').fill(kind.slice(0, 12));
  await page.locator('input[name=password]').fill(randomBytes(12).toString('hex'));
  await page.getByRole('button', { name: '가입하고 내 섬 만들기' }).click();
  await page.waitForURL(`**/@${me.username}`);
  await arrive(me);
  return me;
}

/** Waits for the island and the viewer's place in its live room, keeping the island the owner was first shown. */
async function arrive(me) {
  await me.page.waitForFunction(() => document.querySelector('.mg-world') && !document.querySelector('.mg-world-loading'), undefined, { timeout: WORLD_READY_MS, polling: 250 });
  const chooser = me.page.locator('.mg-island-dialog');
  if (await chooser.isVisible().catch(() => false)) await chooser.getByRole('button', { name: '닫기', exact: true }).click();
  await until(() => me.pose?.position && me.peer, 30_000, `${me.kind} live pose`);
  await sleep(800);
}

const pose = (me) => structuredClone(me.pose);
const distance = (a, b) => Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
const yaw = (state) => {
  // The live room's wire order is w, x, y, z (server/src/rooms.rs), not three.js's.
  const [w, x, y, z] = state.rotation;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
};
const turned = (a, b) => Math.abs(Math.atan2(Math.sin(yaw(b) - yaw(a)), Math.cos(yaw(b) - yaw(a))));
const freshPose = (me, after) =>
  until(
    () => {
      const now = pose(me);
      return now?.at > after && now;
    },
    10_000,
    'fresh live pose',
  );
const shoot = async (me, name) => {
  await me.page.screenshot({ ...SCREENSHOT, path: join(SHOTS, `${name}.png`) });
};
/** The environment the island page says it is in. */
const environment = (page) => page.locator('.mg-world').getAttribute('data-environment');

/** Opens `label` from the 게임 button and starts it as its host. */
async function startGame(me, label, role) {
  const { page } = me;
  await page.locator('.mg-game-toggle').click();
  await page.getByRole('button', { name: label, exact: true }).click();
  if (role) await page.getByLabel('내 역할').selectOption(role);
  const start = page.getByRole('button', { name: /^시작/ });
  await start.and(page.locator(':enabled')).waitFor({ timeout: 20_000 });
  await start.click();
  await until(() => me.session?.phase === 'playing', 20_000, `${label} starts`);
  await page.locator('.mg-world[data-environment=game]').waitFor({ timeout: 20_000 });
}

/** Closes the session from the game panel and waits for the island to come back. */
async function closeGame(me) {
  const { page } = me;
  if ((await page.locator('.mg-game-toggle').getAttribute('aria-expanded')) !== 'true') await page.locator('.mg-game-toggle').click();
  await page.locator('.mg-game').getByRole('button', { name: '닫기', exact: true }).click();
  await until(() => me.session === null, 15_000, 'session closes');
  await page.locator('.mg-world[data-environment=island]').waitFor({ timeout: 20_000 });
}

/** Back where they stood before the game, on the island's ground (not falling through it), and still there a moment on. */
async function backHome(me, before) {
  await sleep(1500);
  const after = await freshPose(me, Date.now());
  assert(distance(before, after) < 2.5, `back ${distance(before, after).toFixed(2)}m from where they stood`);
  assert(Math.abs(after.position[1] - before.position[1]) < 1.5, `back at height ${after.position[1]} (stood at ${before.position[1]})`);
  await sleep(1500);
  const later = await freshPose(me, Date.now());
  assert(Math.abs(later.position[1] - before.position[1]) < 1.5, `fell to ${later.position[1]} after coming back`);
  return later;
}

/**
 * The visible buttons of `selector` (the controls checked, each at least `least` px) and of `beside` (the page's own,
 * only kept clear of): all inside the viewport, and none over another.
 */
async function touchLayout(page, selector, beside = '', least = 44) {
  const viewport = page.viewportSize();
  const measure = (wanted, own) =>
    wanted
      ? page.locator(wanted).evaluateAll(
          (buttons, mine) =>
            buttons
              .filter((button) => button.checkVisibility())
              .map((button) => {
                const rect = button.getBoundingClientRect();
                return { label: button.getAttribute('aria-label') ?? button.textContent.trim(), x: rect.x, y: rect.y, width: rect.width, height: rect.height, mine };
              }),
          own,
        )
      : [];
  const boxes = [...(await measure(selector, true)), ...(await measure(beside, false))];
  for (const box of boxes) {
    if (box.mine) assert(box.width >= least && box.height >= least, `${box.label} is ${box.width}×${box.height}px`);
    assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${box.label} is outside the viewport`);
  }
  for (let a = 0; a < boxes.length; a++)
    for (let b = a + 1; b < boxes.length; b++) {
      const [one, two] = [boxes[a], boxes[b]];
      const overlap = Math.min(one.x + one.width, two.x + two.width) - Math.max(one.x, two.x) > 0.5 && Math.min(one.y + one.height, two.y + two.height) - Math.max(one.y, two.y) > 0.5;
      assert(!overlap, `${one.label} overlaps ${two.label}`);
    }
  return { viewport, boxes };
}

/** A finger on the centre of `locator`, as CDP's touch events take it. */
async function finger(locator, id) {
  await locator.and(locator.page().locator(':enabled')).waitFor();
  const box = await locator.boundingBox();
  assert(box, 'nothing to touch');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, radiusX: 4, radiusY: 4, force: 1, id };
}
const pressed = (page, selector) => page.locator(`${selector}[aria-pressed=true]`).count();

async function kartOnDesktop() {
  const racer = await step('desktop: signs up and reaches their island', () => person('desktop'));
  if (!racer) return;
  const before = pose(racer);
  await shoot(racer, 'desktop-island-before');
  const racing = await step('desktop: the racing island takes the island\'s place for the race', async () => {
    await startGame(racer, '카트');
    await racer.page.locator('.mg-kart-hud').waitFor({ timeout: 30_000 });
    await until(() => racer.session?.game?.phase === 'race', 20_000, 'the countdown ends');
    // Folded at the start: the race's own overlay is enough.
    assert.equal(await racer.page.locator('.mg-game-toggle').getAttribute('aria-expanded'), 'false', 'the game panel stayed open');
    assert.equal(await racer.page.locator('.mg-world-bottom, .mg-rail').evaluateAll((items) => items.filter((item) => item.checkVisibility()).length), 0, 'the island\'s bars are still out');
    await sleep(500);
    const at = await freshPose(racer, Date.now());
    assert(Math.abs(at.position[1]) < 3, `the kart is not at the island's ground: y=${at.position[1]}`);
    const slot = racer.session.game.spawn;
    assert(Math.hypot(at.position[0] - slot[0], at.position[2] - slot[2]) < 3.5, 'not on its grid slot');
    return true;
  });
  if (racing) {
    await step('desktop: keys drive and steer the physics body', async () => {
      const from = pose(racer);
      await racer.page.keyboard.down('w');
      await sleep(1400);
      const straight = await freshPose(racer, from.at);
      await racer.page.keyboard.down('d');
      await sleep(450);
      await racer.page.keyboard.up('d');
      const corner = await freshPose(racer, straight.at);
      await racer.page.keyboard.up('w');
      assert(distance(from, straight) > 3, `drove only ${distance(from, straight).toFixed(2)}m`);
      assert(turned(straight, corner) > 0.08, `steering turned only ${turned(straight, corner).toFixed(3)}`);
      evidence.desktopDrive = { distance: distance(from, straight), turned: turned(straight, corner) };
      await sleep(600);
      await shoot(racer, 'desktop-race');
    });
    await step('desktop: closing the race brings the island back and the racer home', async () => {
      await closeGame(racer);
      assert.equal(await racer.page.locator('.mg-kart-hud').count(), 0);
      evidence.desktopHome = await backHome(racer, before);
      await shoot(racer, 'desktop-island-after');
    });
  }
  await racer.context.close();
}

async function kartOnPhone() {
  const racer = await step('phone: signs up and reaches their island', () => person('phone', PHONE));
  if (!racer) return;
  const { page } = racer;
  await step('phone: the walking pad walks the island, upright and on its side', async () => {
    await page.locator('.mg-walking-controls[data-placement=island]').waitFor();
    const island = '.mg-chatbar, .mg-side-open, .mg-game-toggle, .mg-interact, .mg-rail';
    evidence.islandPadLandscape = await touchLayout(page, '.mg-walking-control', island);
    await shoot(racer, 'mobile-island');
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(400);
    evidence.islandPadPortrait = await touchLayout(page, '.mg-walking-control', island);
    await shoot(racer, 'mobile-island-portrait');
    const cdp = await racer.context.newCDPSession(page);
    const from = pose(racer);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [await finger(page.locator('[data-direction=forward]'), 1)] });
    await sleep(1000);
    assert.equal(await pressed(page, '.mg-walking-control'), 1);
    const moved = await freshPose(racer, from.at);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
    assert.equal(await pressed(page, '.mg-walking-control'), 0, 'the pad stayed held');
    assert(distance(from, moved) > 1, `walked only ${distance(from, moved).toFixed(2)}m`);
    evidence.islandWalk = distance(from, moved);
    await cdp.detach();
    await page.setViewportSize(PHONE.viewport);
    await sleep(400);
  });
  const before = await freshPose(racer, Date.now());
  const racing = await step('phone: the race brings the kart\'s buttons, reachable upright and on its side', async () => {
    await startGame(racer, '카트');
    await page.locator('.mg-kart-touch').waitFor({ timeout: 30_000 });
    await until(() => racer.session?.game?.phase === 'race', 20_000, 'the countdown ends');
    assert.equal(await page.locator('.mg-walking-controls').count(), 0, 'the walking pad is still out while driving');
    evidence.kartLandscape = await touchLayout(page, '.mg-kart-control, .mg-kart-item', '.mg-game-toggle, .mg-kart-hud');
    assert.equal(evidence.kartLandscape.boxes.filter((box) => box.mine).length, 6, 'five buttons and the item');
    await shoot(racer, 'mobile-race');
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(400);
    evidence.kartPortrait = await touchLayout(page, '.mg-kart-control, .mg-kart-item', '.mg-game-toggle, .mg-kart-hud');
    await shoot(racer, 'mobile-race-portrait');
    await page.setViewportSize(PHONE.viewport);
    await sleep(400);
    return true;
  });
  if (racing) {
    const cdp = await racer.context.newCDPSession(page);
    const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    const control = (name, id) => finger(page.locator(`.mg-kart-control[data-control=${name}]`), id);
    await step('phone: fingers accelerate and steer at once, each let go alone', async () => {
      const forward = await control('forward', 1);
      const left = await control('left', 2);
      const from = pose(racer);
      await touch('touchStart', [forward]);
      await sleep(1100);
      const straight = await freshPose(racer, from.at);
      assert.equal(await pressed(page, '.mg-kart-control'), 1);
      const pace = (state) => Math.hypot(state.velocity[0], state.velocity[2]);
      const released = pose(racer);
      assert(pace(released) > 6, `going ${pace(released).toFixed(1)} m/s`);
      await touch('touchEnd', []);
      await sleep(100);
      assert.equal(await pressed(page, '.mg-kart-control'), 0);
      const slowing = await until(() => {
        const now = pose(racer);
        return now.at > released.at && pace(now) < pace(released) - 1.5 && now;
      }, 4000, 'letting go slows the kart');
      await touch('touchStart', [forward]);
      await sleep(300);
      const steering = pose(racer);
      await touch('touchStart', [forward, left]);
      await sleep(250);
      assert.equal(await pressed(page, '.mg-kart-control'), 2, 'a second finger let go of the first');
      const corner = await freshPose(racer, steering.at);
      await touch('touchEnd', [forward]);
      await sleep(100);
      assert.equal(await pressed(page, '.mg-kart-control'), 1, 'lifting the steering finger let go of the throttle');
      await touch('touchEnd', []);
      await sleep(100);
      assert.equal(await pressed(page, '.mg-kart-control'), 0);
      assert(distance(from, straight) > 2, `drove only ${distance(from, straight).toFixed(2)}m`);
      assert(turned(steering, corner) > 0.08, `steering turned only ${turned(steering, corner).toFixed(3)}`);
      evidence.phoneDrive = { distance: distance(from, straight), turned: turned(steering, corner), speeds: [pace(released), pace(slowing)] };
      await shoot(racer, 'mobile-race-driving');
      await touch('touchStart', [await control('back', 3)]);
      await sleep(400);
      await touch('touchEnd', []);
    });
    await step('phone: a cancelled touch and a lost focus let go of every button', async () => {
      await touch('touchStart', [await control('forward', 4), await control('right', 5)]);
      await sleep(150);
      assert.equal(await pressed(page, '.mg-kart-control'), 2);
      await touch('touchCancel', []);
      await sleep(100);
      assert.equal(await pressed(page, '.mg-kart-control'), 0, 'a cancelled touch left a button held');
      const events = await page.evaluate(() => window.__pointers);
      assert(events.some((event) => event.type === 'pointercancel' && event.trusted), 'no pointercancel came');
      // Playwright keeps every page focused; undo that to switch tabs for real.
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      // Another tab comes to the front; headless Chrome now and then misses the switch, so it is tried twice.
      const leave = async () => {
        await page.bringToFront();
        const start = await page.evaluate(() => window.__focus.length);
        await touch('touchStart', [await control('forward', 6)]);
        assert.equal(await pressed(page, '.mg-kart-control'), 1);
        const other = await racer.context.newPage();
        try {
          await other.goto('about:blank');
          await other.bringToFront();
          return await page
            .waitForFunction(
              (from) => window.__focus.slice(from).some((event) => event.trusted && ((event.type === 'blur' && event.window && !event.focused) || (event.type === 'visibilitychange' && event.hidden))),
              start,
              { timeout: 5000 },
            )
            .then(
              () => true,
              () => false,
            );
        } finally {
          await other.close();
          await page.bringToFront();
        }
      };
      try {
        const left = (await leave()) || (await leave());
        assert(left, 'the page never lost focus');
        assert.equal(await pressed(page, '.mg-kart-control'), 0, 'a lost focus left the throttle held');
      } finally {
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await touch('touchCancel', []);
      }
    });
    await cdp.detach();
    await step('phone: closing the race brings the island, its pad and the racer back', async () => {
      await closeGame(racer);
      assert.equal(await page.locator('.mg-kart-touch').count(), 0);
      await page.locator('.mg-walking-controls[data-placement=island]').waitFor();
      evidence.phoneHome = await backHome(racer, before);
      await shoot(racer, 'mobile-island-after');
    });
  }
  await racer.context.close();
}

async function impostorOn(device, mode) {
  const crew = await step(`${mode}: signs up for the ship`, () => person(`ship${mode}`, device));
  if (!crew) return;
  const { page } = crew;
  const before = pose(crew);
  const boarded = await step(`${mode}: the ship takes the island's place at its ground`, async () => {
    await startGame(crew, '임포스터', 'impostor');
    await until(() => crew.session?.game?.phase === 'play', 20_000, 'the game starts');
    await page.locator('.mg-impostor-actions').waitFor();
    await sleep(800);
    const at = await freshPose(crew, Date.now());
    assert(Math.abs(at.position[1]) < 3, `standing at y=${at.position[1]}`);
    assert.equal(await page.locator('.mg-game-toggle').getAttribute('aria-expanded'), 'false', 'the game panel stayed open');
    assert((await page.locator('.mg-impostor-room').count()) >= 10, 'the ship\'s rooms are not there');
    await shoot(crew, `${mode}-ship`);
    return true;
  });
  if (boarded) {
    if (device === PHONE) {
      await step('phone: the pad and the ship\'s buttons fit, upright and on its side', async () => {
        await page.locator('.mg-walking-controls[data-placement=game]').waitFor();
        evidence.shipLandscape = await touchLayout(page, '.mg-walking-control, .mg-impostor-actions button', '.mg-game-toggle');
        await page.setViewportSize({ width: 390, height: 844 });
        await sleep(400);
        evidence.shipPortrait = await touchLayout(page, '.mg-walking-control, .mg-impostor-actions button', '.mg-game-toggle');
        await shoot(crew, 'mobile-ship-portrait');
        await page.setViewportSize(PHONE.viewport);
        await sleep(400);
      });
      await step('phone: the pad walks the ship and a cancelled touch stops it', async () => {
        const cdp = await crew.context.newCDPSession(page);
        const from = pose(crew);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [await finger(page.locator('[data-direction=backward]'), 1)] });
        await sleep(1000);
        assert.equal(await pressed(page, '.mg-walking-control'), 1);
        const moved = await freshPose(crew, from.at);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await sleep(600);
        assert.equal(await pressed(page, '.mg-walking-control'), 0);
        const still = pose(crew);
        assert(distance(from, moved) > 1, `walked only ${distance(from, moved).toFixed(2)}m`);
        assert(Math.hypot(still.velocity?.[0] ?? 0, still.velocity?.[2] ?? 0) < 0.6, 'kept walking after the touch was cancelled');
        evidence.shipWalk = distance(from, moved);
        await cdp.detach();
      });
    } else {
      await step('desktop: keys walk the ship', async () => {
        const from = pose(crew);
        await page.keyboard.down('s');
        await sleep(1000);
        await page.keyboard.up('s');
        const moved = await freshPose(crew, from.at);
        assert(distance(from, moved) > 1, `walked only ${distance(from, moved).toFixed(2)}m`);
      });
    }
    await step(`${mode}: closing the game brings the island and the player back`, async () => {
      await closeGame(crew);
      assert.equal(await page.locator('.mg-impostor-room').count(), 0);
      evidence[`${mode}ShipHome`] = await backHome(crew, before);
      await shoot(crew, `${mode}-ship-island-after`);
    });
  }
  await crew.context.close();
}

async function watchARace() {
  const host = await step('watch: a host signs up', () => person('host'));
  const guest = await step('watch: a guest signs up', () => person('guest'));
  if (!host || !guest) return;
  const visited = await step('watch: the guest visits the host\'s island', async () => {
    guest.pose = null;
    guest.peer = null;
    await guest.page.goto(`${WEB}/@${host.username}`);
    await arrive(guest);
    return true;
  });
  if (!visited) return;
  const before = await freshPose(guest, Date.now());
  const watching = await step('watch: the guest is taken to the stand beside the start, and the room takes the jump', async () => {
    await startGame(host, '카트');
    await guest.page.locator('.mg-world[data-environment=game]').waitFor({ timeout: 20_000 });
    const stand = await until(() => guest.session?.stand, 20_000, 'the guest is given the stand');
    assert.deepEqual(stand, KART_STAND);
    const there = await until(() => {
      const now = pose(guest);
      return now && Math.hypot(now.position[0] - stand[0], now.position[2] - stand[2]) <= STAND_REACH && now;
    }, 10_000, 'the guest stands at the stand');
    // As the host's page is told: at once (a jump the room took), not sliding there at a walk.
    const relayed = await until(() => {
      const seen = host.relayed.get(guest.peer);
      return seen && Math.hypot(seen.position[0] - stand[0], seen.position[2] - stand[2]) <= STAND_REACH + 1 && seen;
    }, 5000, 'the host sees the guest at the stand');
    evidence.watch = { stand, guest: there.position, relayed: relayed.position };
    assert.equal(await guest.page.locator('.mg-kart-touch, .mg-kart-hud').count(), 0, 'a watcher got the racer\'s controls');
    await sleep(2500);
    await shoot(guest, 'watch-race');
    return true;
  });
  if (watching) {
    await step('watch: once the host closes the race, the guest is home again', async () => {
      await closeGame(host);
      await guest.page.locator('.mg-world[data-environment=island]').waitFor({ timeout: 20_000 });
      evidence.watchHome = await backHome(guest, before);
    });
  }
  await guest.context.close();
  await host.context.close();
}

try {
  await setup();
  if (!options.only || options.only === 'kart') {
    await kartOnDesktop();
    await kartOnPhone();
  }
  if (!options.only || options.only === 'impostor') {
    await impostorOn(DESKTOP, 'desktop');
    await impostorOn(PHONE, 'mobile');
  }
  if (!options.only || options.only === 'watch') await watchARace();
} catch (error) {
  problems.push(`setup: ${firstLine(error)}`);
  console.log(`FAIL setup: ${error.message}`);
} finally {
  await cleanup();
  evidence.problems = problems;
  evidence.elapsedMs = Date.now() - began;
  writeFileSync(join(SHOTS, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.join('\n')}` : `\ngames e2e passed (${Math.round(evidence.elapsedMs / 1000)}s); ${SHOTS}`);
}
process.exitCode = problems.length ? 1 : 0;
