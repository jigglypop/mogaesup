// End-to-end island kinds in Chrome, without the character server and without spending money. It builds and starts the
// Rust server (server/) on a throwaway database and this app's dev server (scripts/e2e/dev-server.mjs) on spare ports,
// each in a process of its own. For every kind of island a new member picks it in 섬 고르기 on their first visit, and the
// island is photographed from the start, wide without the page around it (the chooser's card picture, written to
// public/islands/<id>.webp) and from above while decorating. One member closes the chooser and keeps the forest; one
// changes a city into a café through 섬 바꾸기 and goes back with 이전 섬, and the stored island says city again. Then
// an owner and a visitor meet on one island: the owner picks each speech balloon in 소개 and talks, and the visitor's
// screen is photographed around it (.data/balloons, or balloons/ in the screenshot folder). Page errors and console
// errors fail the run. Whatever happens, it stops what it started and drops its database; what a run killed outright
// leaves, the next run removes.
// Usage: node scripts/islands-e2e.mjs [screenshotDir] [--no-pictures] [--only=city,cafe,balloons]
//   (needs the local PostgreSQL at 127.0.0.1:55432, cargo and Chrome; CARGO_TARGET_DIR is honoured)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createListener } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import sharp from 'sharp';

import { sql } from './e2e/pg.mjs';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = resolve(FRONTEND, '../server');
const args = process.argv.slice(2);
const SHOTS = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(FRONTEND, '../.data/islands'));
const PICTURES = !args.includes('--no-pictures');
const ONLY = args.find((arg) => arg.startsWith('--only='))?.slice(7).split(',');
const POSTGRES = `postgres://postgres:${process.env['POSTGRES_PASSWORD'] ?? 'postgres-dev'}@127.0.0.1:55432`;
const WORLD_READY_MS = 120_000;
const KINDS = [
  ['forest', '숲'],
  ['city', '도시'],
  ['cafe', '카페'],
  ['park', '공원'],
  ['farm', '농장'],
  ['beach', '해변'],
  ['camp', '캠핑'],
  ['winter', '겨울'],
].filter(([id]) => !ONLY || ONLY.includes(id));
/** The stored island's world id (frontend/src/minihome/world.ts), and the one its kept island goes to. */
const WORLD_ID = 'minihome-v6';
const BEFORE_ID = `${WORLD_ID}-before`;

const began = Date.now();
mkdirSync(SHOTS, { recursive: true });
const problems = [];

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
function run(command, commandArgs, options) {
  return new Promise((done, fail) => {
    const child = spawn(command, commandArgs, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    cleanups.push(() => stop(child));
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.once('error', fail);
    child.once('exit', (code) =>
      code === 0 ? done(output) : fail(new Error(`${command} ${commandArgs.join(' ')} failed (${code}):\n${output.slice(-4000)}`)),
    );
  });
}
async function until(check, timeout, what) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline; await sleep(250)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`${what}: not within ${timeout / 1000}s`);
}
const firstLine = (error) => String(error?.message ?? error).split('\n')[0];
async function setup(label, work) {
  const started = Date.now();
  const value = await work();
  console.log(`ok   ${label} (${Date.now() - started}ms)`);
  return value;
}
const passed = new Set();
async function step(id, label, work, needs = []) {
  const missing = needs.filter((need) => !passed.has(need));
  if (missing.length) {
    problems.push(`${label}: skipped`);
    console.log(`skip ${label} (needs ${missing.join(', ')})`);
    return;
  }
  const started = Date.now();
  try {
    const note = await work();
    passed.add(id);
    console.log(`ok   ${label} (${Date.now() - started}ms)${note ? ` · ${note}` : ''}`);
  } catch (error) {
    problems.push(`${label}: ${firstLine(error)}`);
    console.log(`FAIL ${label}: ${firstLine(error)}`);
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
function watch(child, name) {
  cleanups.push(() => stop(child));
  child.once('exit', (code) => cleaning || problems.push(`${name} exited (${code})`));
  return child;
}
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

let browser;
let WEB = '';
let work = '';
let serverLog = '';
try {
  work = mkdtempSync(join(tmpdir(), `mogaesup-islands-e2e-${process.pid}-`));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  for (const name of readdirSync(tmpdir())) {
    const pid = Number(/^mogaesup-islands-e2e-(\d+)-/.exec(name)?.[1]);
    if (pid && !running(pid)) rmSync(join(tmpdir(), name), { recursive: true, force: true, maxRetries: 2 });
  }

  const exe = process.platform === 'win32' ? 'mogaesup-server.exe' : 'mogaesup-server';
  await setup('Rust server builds', () => run('cargo', ['build', '--quiet'], { cwd: SERVER_DIR }));
  const target = resolve(SERVER_DIR, process.env['CARGO_TARGET_DIR'] ?? 'target');
  copyFileSync(join(target, 'debug', exe), join(work, exe));

  const database = `mogaesup_islands_${process.pid}_${randomBytes(3).toString('hex')}`;
  await setup(`throwaway database ${database}`, async () => {
    const admin = `${POSTGRES}/postgres`;
    const listed = await sql(admin, "SELECT datname FROM pg_database WHERE datname LIKE 'mogaesup\\_islands\\_%'").catch((error) => {
      throw new Error(`${error.message} (PostgreSQL at 127.0.0.1:55432 as postgres, POSTGRES_PASSWORD or postgres-dev)`);
    });
    for (const [name] of listed) {
      const pid = Number(/^mogaesup_islands_(\d+)_/.exec(name)?.[1]);
      if (pid && !running(pid)) await sql(admin, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    await sql(admin, `CREATE DATABASE ${database}`);
  });
  cleanups.push(() => sql(`${POSTGRES}/postgres`, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`));

  const [apiPort, webPort] = [await freePort(), await freePort()];
  const API = `http://127.0.0.1:${apiPort}`;
  WEB = `http://127.0.0.1:${webPort}`;
  const env = { ...process.env };
  for (const key of ['FACTORY_URL', 'FACTORY_JWT_SECRET', 'FACTORY_API_KEY', 'FACTORY_GATEWAY_KEY', 'BOOTSTRAP_ADMIN_USERNAME', 'BOOTSTRAP_ADMIN_PASSWORD'])
    delete env[key];
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
  serverLog = join(work, 'server.log');
  const log = createWriteStream(serverLog);
  cleanups.push(() => new Promise((done) => log.end(done)));
  const server = watch(spawn(join(work, exe), [], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env }), 'Rust server');
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  await setup(`Rust server at ${API}`, () => answers(`${API}/api/health`, server, 'the Rust server'));

  const vite = watch(
    spawn(process.execPath, [join(FRONTEND, 'scripts/e2e/dev-server.mjs'), String(webPort), 'islands'], {
      cwd: FRONTEND,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, SERVER_URL: API },
    }),
    'web dev server',
  );
  await setup(`web dev server at ${WEB}`, () => answers(WEB, vite, 'the web dev server'));

  browser = await chromium.launch({
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])],
  });
  cleanups.push(() => browser.close());
} catch (error) {
  problems.push(`setup: ${firstLine(error)}`);
  console.log(`FAIL setup: ${error.message}`);
}

/** A signed-out browser of its own whose page errors and console errors are kept. */
async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(`${name} pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`${name} console: ${message.text().slice(0, 300)}`);
  });
  return page;
}
const worldReady = (page) =>
  page.waitForFunction(() => document.querySelector('.mg-world') && !document.querySelector('.mg-world-loading'), undefined, {
    timeout: WORLD_READY_MS,
    polling: 250,
  });
async function json(page, path) {
  const response = await page.request.get(`${WEB}${path}`);
  if (!response.ok()) throw new Error(`GET ${path} answered ${response.status()}`);
  return response.status() === 204 ? null : response.json();
}
/** Signs a new member up and waits for 섬 고르기 over their island. */
async function signUp(page, username) {
  await page.goto(WEB);
  await page.getByRole('tab', { name: '가입하기' }).click();
  await page.locator('input[name=username]').fill(username);
  await page.locator('input[name=displayName]').fill(username);
  await page.locator('input[name=password]').fill(randomBytes(9).toString('hex'));
  await page.getByRole('button', { name: '가입하고 내 섬 만들기' }).click();
  await page.waitForURL(`**/@${username}`);
  const dialog = page.getByRole('dialog', { name: '섬 고르기' });
  await dialog.waitFor({ timeout: WORLD_READY_MS });
  return dialog;
}
/** The island's own save, as stored. */
const storedKind = async (page, username, worldId = WORLD_ID) => (await json(page, `/api/homes/${username}/world?worldId=${worldId}`))?.data?.domains?.island?.template;
/** Waits for the next save of the island itself (not of the one kept from before) and checks it was taken. */
const saveOf = (page) =>
  page
    .waitForResponse(
      (response) => {
        const request = response.request();
        if (!response.url().endsWith('/api/homes/me/world') || request.method() !== 'PUT') return false;
        try {
          return JSON.parse(request.postData() ?? '{}').worldId === WORLD_ID;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .then((response) => {
      if (response.status() !== 200) throw new Error(`saving the island answered ${response.status()}`);
    });
/** The page without its panels and bars, the island drawn alone. */
const bare = (page) => page.addStyleTag({ content: '.mg-world > :not(.mg-world-canvas) { visibility: hidden !important; }' });
async function zoomOut(page, steps) {
  const area = await page.locator('.mg-world-canvas canvas').boundingBox();
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, 400);
    await sleep(80);
  }
}

/**
 * Speech balloons: an owner and a visitor on the owner's island. The owner picks each design in 소개 (joining the room
 * again in its colour) and says a short line and one of 80 letters; the visitor's screen is photographed around the
 * owner's balloon, light and dark, and the long line must wrap into four lines with its ellipsis whole and the balloon
 * on the screen. Then the owner's own balloon, two stacked, and none left once their time is up; a sheet of it all.
 */
async function balloonsMeet() {
  const out = args.some((arg) => !arg.startsWith('--')) ? join(SHOTS, 'balloons') : resolve(FRONTEND, '../.data/balloons');
  mkdirSync(out, { recursive: true });
  const designs = JSON.parse(readFileSync(join(FRONTEND, 'src/minihome/balloons/designs.json'), 'utf8'));
  const SHORT = '안녕! 반가워요';
  const LONG =
    '오늘 모개숲에 놀러 와 줘서 정말 고마워요! 연못 옆 벤치에서 같이 사진도 찍고, 밭에 심은 당근이랑 호박도 구경해요. 다음엔 우리 섬에 와요!';
  if ([...LONG].length !== 80) throw new Error(`the long line has ${[...LONG].length} letters`);
  const rgb = (hex) => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;
  const accents = designs.flatMap((design) => (design.accent ? [rgb(design.accent)] : []));

  /** A member signed up through the API, in a browser of their own. */
  async function member(username, displayName) {
    const page = await person(username);
    const response = await page.request.post(`${WEB}/api/auth/register`, {
      data: { username, displayName, password: randomBytes(9).toString('hex') },
      headers: { origin: WEB },
    });
    if (response.status() !== 201) throw new Error(`signing up ${username} answered ${response.status()}`);
    return page;
  }
  const chat = (page) => page.locator('input[aria-label="말하기"]');
  async function say(page, line) {
    await chat(page).waitFor({ timeout: 30_000 });
    await chat(page).fill(line);
    await chat(page).press('Enter');
  }
  const balloons = (page) => page.locator('.mg-balloon-layer .mg-balloon');
  /** Waits for `line` in `design` on `page`, placed and grown. */
  async function seen(page, design, line) {
    await page.waitForFunction(
      ({ design, line }) =>
        [...document.querySelectorAll(`.mg-balloon-layer .mg-balloon[data-design="${design}"]`)].some(
          (element) => element.textContent === line && element.style.opacity === '' && element.style.display !== 'none',
        ),
      { design, line },
      { timeout: 20_000 },
    );
    await sleep(700);
  }
  const theme = (page, name) => page.evaluate((name) => (document.documentElement.dataset.theme = name), name);
  /** The page around the balloon saying `line` (560 × 380). */
  async function shoot(page, name, line) {
    const box = await balloons(page).filter({ hasText: line }).last().boundingBox();
    if (!box) throw new Error(`${name}: no balloon`);
    const x = Math.max(0, Math.min(1600 - 560, box.x + box.width / 2 - 280));
    const y = Math.max(0, Math.min(900 - 380, box.y - 50));
    await page.screenshot({ path: join(out, `${name}.png`), clip: { x, y, width: 560, height: 380 }, timeout: 90_000 });
  }

  const suffix = randomBytes(2).toString('hex');
  const ownerName = `bl_owner_${suffix}`;
  const owner = await member(ownerName, '모개');
  const visitor = await member(`bl_guest_${suffix}`, '손님');
  try {
    await owner.goto(`${WEB}/@${ownerName}`);
    const chooser = owner.getByRole('dialog', { name: '섬 고르기' });
    await chooser.waitFor({ timeout: WORLD_READY_MS });
    const kept = saveOf(owner);
    await chooser.getByRole('button', { name: '닫기', exact: true }).click();
    await kept;
    await chooser.waitFor({ state: 'detached' });
    await worldReady(owner);
    await visitor.goto(`${WEB}/@${ownerName}`);
    await worldReady(visitor);
    await chat(visitor).waitFor({ timeout: 60_000 });
    await chat(owner).waitFor({ timeout: 60_000 });

    await owner.getByRole('tab', { name: '소개', exact: true }).click();
    const picker = owner.getByRole('radiogroup', { name: '말풍선' });
    await picker.waitFor();
    await picker.scrollIntoViewIfNeeded();
    await sleep(400);
    await picker.screenshot({ path: join(out, 'picker.png') });
    await theme(owner, 'dark');
    await sleep(300);
    await picker.screenshot({ path: join(out, 'picker-dark.png') });
    await theme(owner, 'light');

    let current = 'glass';
    for (const design of designs) {
      if (design.id !== current) {
        const saved = owner.waitForResponse((r) => r.url().endsWith('/api/homes/me') && r.request().method() === 'PATCH');
        await picker.getByRole('radio', { name: design.label, exact: true }).click();
        const reply = await saved;
        if (reply.status() !== 200) throw new Error(`${design.id}: picking it answered ${reply.status()}`);
        current = design.id;
      }
      // The visitor sees the owner join again in the design's colour (with the default, in one no design has).
      await visitor.waitForFunction(
        ({ want, accents }) => {
          const face = document.querySelector('.mg-chatbar-people i');
          const color = face && getComputedStyle(face).backgroundColor;
          return !!color && (want ? color === want : !accents.includes(color));
        },
        { want: design.accent ? rgb(design.accent) : null, accents },
        { timeout: 30_000 },
      );
      await chat(owner).waitFor({ timeout: 30_000 });
      await sleep(500);
      await say(owner, SHORT);
      await seen(visitor, design.id, SHORT);
      await shoot(visitor, `${design.id}-short`, SHORT);
      await say(owner, LONG);
      await seen(visitor, design.id, LONG);
      const fit = await visitor.evaluate((line) => {
        const balloon = [...document.querySelectorAll('.mg-balloon-layer .mg-balloon')].find((element) => element.textContent === line);
        const words = balloon.querySelector('b');
        const style = getComputedStyle(words);
        const body = balloon.querySelector('.mg-balloon-body').getBoundingClientRect();
        const layer = balloon.parentElement.getBoundingClientRect();
        return {
          lines: Math.round(words.clientHeight / parseFloat(style.lineHeight)),
          // How far the ellipsis runs past the words' box: within its padding, it is drawn whole.
          spill: words.scrollWidth - words.clientWidth - parseFloat(style.paddingRight),
          inside: body.left >= layer.left - 0.5 && body.right <= layer.right + 0.5,
        };
      }, LONG);
      if (fit.lines !== 4 || fit.spill > 0.5 || !fit.inside) throw new Error(`${design.id}: the long line ${JSON.stringify(fit)}`);
      await shoot(visitor, design.id, LONG);
      await theme(visitor, 'dark');
      await sleep(250);
      await shoot(visitor, `${design.id}-dark`, LONG);
      await theme(visitor, 'light');
    }

    // The owner's own balloon over their own head, the only one they see of theirs.
    const mine = '내 말풍선은 이렇게 보여요';
    await say(owner, mine);
    await seen(owner, current, mine);
    if ((await balloons(owner).count()) !== 1) throw new Error(`the owner sees ${await balloons(owner).count()} balloons of their own`);
    await shoot(owner, 'own', mine);
    // Two at once on the visitor's screen: the farther one goes up over the nearer.
    await say(owner, LONG);
    await seen(visitor, current, LONG);
    await say(visitor, '저도 왔어요!');
    await sleep(900);
    const boxes = await balloons(visitor).evaluateAll((all) => all.map((element) => element.getBoundingClientRect().toJSON()));
    if (boxes.length !== 2) throw new Error(`the visitor sees ${boxes.length} balloons, not two`);
    const [a, b] = boxes;
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) throw new Error('two balloons cover each other');
    const left = Math.max(0, Math.min(a.left, b.left) - 120);
    const top = Math.max(0, Math.min(a.top, b.top) - 60);
    await visitor.screenshot({
      path: join(out, 'stack.png'),
      clip: { x: left, y: top, width: Math.min(900, 1600 - left), height: Math.min(650, 900 - top) },
      timeout: 90_000,
    });
    // Long enough for the 80 letters' 8 seconds.
    await sleep(8600);
    const still = await balloons(visitor).count();
    if (still) throw new Error(`${still} balloons still up after their time`);
  } finally {
    await owner.context().close();
    await visitor.context().close();
  }

  // One sheet: each design short, long and dark.
  const shots = designs.flatMap(({ id }) => [`${id}-short`, id, `${id}-dark`]);
  const cells = shots
    .map((name) => {
      const data = readFileSync(join(out, `${name}.png`)).toString('base64');
      return `<figure><img src="data:image/png;base64,${data}"><figcaption>${name}</figcaption></figure>`;
    })
    .join('');
  const sheet = await browser.newPage({ viewport: { width: 1740, height: 900 } });
  try {
    await sheet.setContent(
      '<style>body{margin:12px;font:600 14px sans-serif;background:#eee}main{display:grid;grid-template-columns:repeat(3,560px);' +
        `gap:12px}figure{margin:0}img{display:block;width:560px;height:380px;border-radius:8px}figcaption{padding:4px 2px}</style><main>${cells}</main>`,
    );
    await sheet.screenshot({ path: join(out, 'sheet.png'), fullPage: true, timeout: 90_000 });
  } finally {
    await sheet.close();
  }
  return `${designs.length} designs, ${shots.length} shots in ${out}`;
}

if (browser) {
  for (const [id, label] of KINDS) {
    await step(
      id,
      `${label}: picked on the first visit, photographed`,
      async () => {
        const username = `isl_${id}_${randomBytes(2).toString('hex')}`;
        const page = await person(id);
        try {
          const dialog = await signUp(page, username);
          const saved = saveOf(page);
          await dialog.getByRole('button', { name: label, exact: true }).click();
          await saved;
          await dialog.waitFor({ state: 'detached' });
          if ((await storedKind(page, username)) !== id) throw new Error(`the stored island is not a ${id}`);
          await worldReady(page);
          await sleep(1500);
          await page.screenshot({ path: join(SHOTS, `${id}-home.png`), timeout: 90_000 });
          const chrome = await bare(page);
          await zoomOut(page, 6);
          await sleep(2000);
          const wide = await page.screenshot({ path: join(SHOTS, `${id}-wide.png`), timeout: 90_000 });
          if (PICTURES) {
            await sharp(wide).resize(480, 300, { fit: 'cover', position: 'centre' }).webp({ quality: 82 }).toFile(join(FRONTEND, 'public/islands', `${id}.webp`));
          }
          await chrome.evaluate((node) => node.remove());
          await page.goto(`${WEB}/@${username}/edit`);
          await worldReady(page);
          await page.getByRole('button', { name: '위에서 보기' }).click();
          await sleep(1000);
          await bare(page);
          await zoomOut(page, 8);
          await sleep(1800);
          await page.screenshot({ path: join(SHOTS, `${id}-top.png`), timeout: 90_000 });
        } finally {
          await page.context().close();
        }
      },
    );
  }

  await step('kept', 'closing the first chooser keeps the forest', async () => {
    const username = `isl_keep_${randomBytes(2).toString('hex')}`;
    const page = await person('keep');
    try {
      const dialog = await signUp(page, username);
      const saved = saveOf(page);
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
      await saved;
      await dialog.waitFor({ state: 'detached' });
      if ((await storedKind(page, username)) !== 'forest') throw new Error('the kept island is not the forest');
      await page.reload();
      await worldReady(page);
      if (await page.getByRole('dialog', { name: '섬 고르기' }).count()) throw new Error('the chooser asked again');
    } finally {
      await page.context().close();
    }
  });

  await step('changed', 'a city becomes a café through 섬 바꾸기, and 이전 섬 brings the city back', async () => {
    const username = `isl_swap_${randomBytes(2).toString('hex')}`;
    const page = await person('swap');
    try {
      const dialog = await signUp(page, username);
      const first = saveOf(page);
      await dialog.getByRole('button', { name: '도시', exact: true }).click();
      await first;
      await page.goto(`${WEB}/@${username}/edit`);
      await worldReady(page);
      await page.getByRole('button', { name: '섬 바꾸기', exact: true }).click();
      let chooser = page.getByRole('dialog', { name: '섬 바꾸기' });
      await chooser.getByRole('button', { name: /^카페/ }).click();
      await chooser.getByText('카페로 바꿀까요?').waitFor();
      const changed = saveOf(page);
      await chooser.getByRole('button', { name: '바꾸기', exact: true }).click();
      await changed;
      await chooser.waitFor({ state: 'detached' });
      if ((await storedKind(page, username)) !== 'cafe') throw new Error('the island did not become a café');
      if ((await storedKind(page, username, BEFORE_ID)) !== 'city') throw new Error('the city was not kept');
      await page.screenshot({ path: join(SHOTS, 'changed-cafe.png'), timeout: 90_000 });

      await page.getByRole('button', { name: '섬 바꾸기', exact: true }).click();
      chooser = page.getByRole('dialog', { name: '섬 바꾸기' });
      await chooser.getByRole('button', { name: /^이전 섬/ }).click();
      await chooser.getByText('이전 섬으로 바꿀까요?').waitFor();
      const restored = saveOf(page);
      await chooser.getByRole('button', { name: '바꾸기', exact: true }).click();
      await restored;
      await chooser.waitFor({ state: 'detached' });
      if ((await storedKind(page, username)) !== 'city') throw new Error('이전 섬 did not bring the city back');
      if ((await storedKind(page, username, BEFORE_ID)) !== 'cafe') throw new Error('the café was not kept in turn');
      await page.screenshot({ path: join(SHOTS, 'restored-city.png'), timeout: 90_000 });
    } finally {
      await page.context().close();
    }
  });

  if (!ONLY || ONLY.includes('balloons')) {
    await step('balloons', 'speech balloons: every design as a visitor sees it, light and dark', balloonsMeet);
  }
}

const unexpected = problems.filter((problem) => !/favicon|DevTools/.test(problem));
if (unexpected.length && serverLog) {
  try {
    console.log(`\nRust server log (last lines):\n${readFileSync(serverLog, 'utf8').trim().split('\n').slice(-25).join('\n')}`);
  } catch {
    // The log is gone with the run's folder.
  }
}
await cleanup();
const seconds = Math.round((Date.now() - began) / 1000);
console.log(
  unexpected.length === 0
    ? `\nislands e2e passed in ${seconds}s; screenshots in ${SHOTS}`
    : `\n${unexpected.length} problem(s) in ${seconds}s:\n${unexpected.join('\n')}`,
);
process.exit(unexpected.length === 0 ? 0 : 1);
