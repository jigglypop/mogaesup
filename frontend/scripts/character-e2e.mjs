// End-to-end character test in Chrome, without the character server and without spending money. It builds and starts
// the Rust server (server/) on a throwaway database with a fake character server (scripts/e2e/fake-character-server.mjs)
// behind its studio gateway, and this app's dev server (scripts/e2e/dev-server.mjs) in front, all on spare ports and in
// processes of their own. Then an admin imports a finished studio character into the 미니미 catalog and publishes it, and
// opens the studio; a new member walks their island as that character and opens the wardrobe; a re-import keeps the item
// public as a new version, and a character without a walk clip is refused with a readable reason. Whatever happens, it
// stops what it started and drops its database; what a run killed outright leaves, the next run removes.
// Usage: node scripts/character-e2e.mjs [screenshotDir]   (needs the local PostgreSQL at 127.0.0.1:55432, cargo and Chrome)
import { fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createListener } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { sql } from './e2e/pg.mjs';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = resolve(FRONTEND, '../server');
const SHOTS = resolve(process.argv[2] ?? join(FRONTEND, '../.data/character-e2e'));
const POSTGRES = `postgres://postgres:${process.env['POSTGRES_PASSWORD'] ?? 'postgres-dev'}@127.0.0.1:55432`;
const WORLD_READY_MS = 120_000;
const IMPORT_MS = 120_000;
const SCREENSHOT = { type: 'jpeg', quality: 70, timeout: 90_000, animations: 'disabled' };
const ADMIN = { username: 'e2e_admin', password: randomBytes(9).toString('hex') };
const MEMBER = { username: 'e2e_member', displayName: '이투이', password: randomBytes(9).toString('hex') };
const ITEM = 'e2e-hero';
const REFUSED_ITEM = 'e2e-no-walk';

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
// Output piped into something that quits early must not skip the cleanup.
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
/** Runs a command to its end, keeping its output for the error when it fails. */
function run(command, args, options) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    cleanups.push(() => stop(child));
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.once('error', fail);
    child.once('exit', (code) =>
      code === 0 ? done(output) : fail(new Error(`${command} ${args.join(' ')} failed (${code}):\n${output.slice(-4000)}`)),
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
/** One checked step; it is skipped when a step it needs did not pass. */
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

let serverLog = '';
let fake;
let browser;
let WEB = '';
/** Whether the run with process id `pid` is still going. */
const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
/** Watches a helper process: when it dies before the end, that is a problem of its own. */
function watch(child, name) {
  cleanups.push(() => stop(child));
  child.once('exit', (code) => cleaning || problems.push(`${name} exited (${code})`));
  return child;
}
/** The fake character server in a process of its own, spoken to over IPC. */
async function startFake() {
  const child = watch(
    fork(join(FRONTEND, 'scripts/e2e/fake-character-server.mjs'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }),
    'fake character server',
  );
  const replies = new Map();
  const ask = (message) =>
    new Promise((done, fail) => {
      const id = replies.size + 1;
      replies.set(id, done);
      child.send({ ...message, id });
      setTimeout(() => fail(new Error('the fake character server did not answer')), 10_000);
    });
  const ready = await new Promise((done, fail) => {
    child.once('exit', (code) => fail(new Error(`the fake character server exited (${code})`)));
    child.on('message', (message) => (message.ready ? done(message.ready) : replies.get(message.id)?.(message)));
  });
  return { ...ready, reseal: (name) => ask({ reseal: name }), problems: () => ask({}).then((reply) => reply.problems) };
}

try {
  // Runs killed outright could not clean up: their files and databases carry their process id, and go now.
  const work = mkdtempSync(join(tmpdir(), `mogaesup-character-e2e-${process.pid}-`));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  for (const name of readdirSync(tmpdir())) {
    const pid = Number(/^mogaesup-character-e2e-(\d+)-/.exec(name)?.[1]);
    if (pid && !running(pid)) rmSync(join(tmpdir(), name), { recursive: true, force: true, maxRetries: 2 });
  }

  const exe = process.platform === 'win32' ? 'mogaesup-server.exe' : 'mogaesup-server';
  await setup('Rust server builds', () => run('cargo', ['build', '--quiet'], { cwd: SERVER_DIR }));
  // A copy runs, so cargo can build and test while this runs.
  const target = resolve(SERVER_DIR, process.env['CARGO_TARGET_DIR'] ?? 'target');
  copyFileSync(join(target, 'debug', exe), join(work, exe));

  const database = `mogaesup_e2e_${process.pid}_${randomBytes(3).toString('hex')}`;
  await setup(`throwaway database ${database}`, async () => {
    const admin = `${POSTGRES}/postgres`;
    const listed = await sql(admin, "SELECT datname FROM pg_database WHERE datname LIKE 'mogaesup\_e2e\_%'").catch((error) => {
      throw new Error(
        `${error.message} (PostgreSQL at 127.0.0.1:55432 as postgres, POSTGRES_PASSWORD or postgres-dev: cd server && docker compose up -d --wait)`,
      );
    });
    for (const [name] of listed) {
      const pid = Number(/^mogaesup_e2e_(\d+)_/.exec(name)?.[1]);
      if (pid && !running(pid)) await sql(admin, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    await sql(admin, `CREATE DATABASE ${database}`);
  });
  cleanups.push(() => sql(`${POSTGRES}/postgres`, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`));

  fake = await setup('fake character server', startFake);

  const [apiPort, webPort] = [await freePort(), await freePort()];
  const API = `http://127.0.0.1:${apiPort}`;
  WEB = `http://127.0.0.1:${webPort}`;
  serverLog = join(work, 'server.log');
  const log = createWriteStream(serverLog);
  cleanups.push(() => new Promise((done) => log.end(done)));
  // Its logs go through this process, so it also stops when this one is killed.
  const server = spawn(join(work, exe), [], {
    cwd: work,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DATABASE_URL: `${POSTGRES}/${database}`,
      LISTEN_ADDR: `127.0.0.1:${apiPort}`,
      APP_ORIGIN: WEB,
      COOKIE_SECURE: 'false',
      REALTIME_TICKET_SECRET: randomBytes(36).toString('base64'),
      MODEL_STORE: join(work, 'models'),
      RUST_LOG: 'info',
      NO_COLOR: '1',
      BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
      BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      FACTORY_URL: fake.url,
      FACTORY_ACCESS: 'write',
      FACTORY_PAID_MONTHLY: '0',
      FACTORY_API_KEY: fake.keys.apiKey,
      FACTORY_GATEWAY_KEY: fake.keys.gatewayKey,
      FACTORY_JWT_SECRET: fake.keys.jwtSecret,
      FACTORY_JWT_ISSUER: fake.jwt.issuer,
      FACTORY_JWT_AUDIENCE: fake.jwt.audience,
      FACTORY_OWNER_ID: '1',
    },
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  watch(server, 'Rust server');
  /** Waits for `url` to answer while `child` still runs. */
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
  await setup(`Rust server at ${API}`, () => answers(`${API}/api/health`, server, 'the Rust server'));

  // Its stdin is a pipe from here, so it stops when this process goes, however that happens.
  const vite = watch(
    spawn(process.execPath, [join(FRONTEND, 'scripts/e2e/dev-server.mjs'), String(webPort)], {
      cwd: FRONTEND,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, SERVER_URL: API },
    }),
    'web dev server',
  );
  await setup(`web dev server at ${WEB}`, () => answers(WEB, vite, 'the web dev server'));

  browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-webgpu', '--use-angle=d3d11', '--enable-gpu'] });
  cleanups.push(() => browser.close());
} catch (error) {
  problems.push(`setup: ${firstLine(error)}`);
  console.log(`FAIL setup: ${error.message}`);
}

/** A signed-out browser of its own, whose page errors, console errors and live-room messages are kept. */
async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    const at = error.stack?.split('\n').find((line) => line.trim().startsWith('at '));
    problems.push(`${name} pageerror: ${error.message}${at ? ` (${at.trim()})` : ''}`);
  });
  page.on('console', (message) => {
    const where = message.location().url;
    if (message.type() === 'error')
      problems.push(`${name} console: ${message.text().slice(0, 300)}${where ? ` (${where})` : ''}`);
  });
  const sent = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      try {
        sent.push(JSON.parse(String(payload)));
      } catch {
        // Not a room message.
      }
    }),
  );
  return { page, sent };
}
const worldReady = (page) => page.locator('.mg-world-loading.is-done').waitFor({ state: 'attached', timeout: WORLD_READY_MS });
const shoot = (page, name) => page.screenshot({ ...SCREENSHOT, path: join(SHOTS, `${name}.jpg`) });
async function json(page, path) {
  const response = await page.request.get(`${WEB}${path}`);
  if (!response.ok()) throw new Error(`GET ${path} answered ${response.status()}`);
  return response.json();
}
/** Whether a picture loads (the page swaps a broken one for an emoji); lazy ones are scrolled to first. */
async function pictureLoads(image) {
  await image.scrollIntoViewIfNeeded();
  return image.evaluate((element) =>
    Promise.race([
      element.decode().then(
        () => element.naturalWidth > 0,
        () => false,
      ),
      new Promise((done) => setTimeout(() => done(false), 15_000)),
    ]),
  );
}

let admin;
let member;
let memberSent = [];
let modelUrl = '';
const board = () => admin.getByRole('region', { name: '스튜디오 완성' });

/** Starts an import from a character card with `button` and follows it to its end through the API. */
async function importFrom(card, button) {
  const queued = admin.waitForResponse(
    (response) => response.url().endsWith('/api/catalog/admin/import') && response.request().method() === 'POST',
  );
  await card.getByRole('button', { name: button, exact: true }).click();
  const response = await queued;
  if (response.status() !== 202) throw new Error(`import answered ${response.status()}: ${await response.text()}`);
  const { id } = await response.json();
  return until(
    async () => {
      const item = await json(admin, `/api/catalog/admin/imports/${id}`);
      return ['done', 'failed'].includes(item.status) && item;
    },
    IMPORT_MS,
    'the import to finish',
  );
}
const levels = (report, level) => (report?.checks ?? []).filter((check) => check.level === level);

if (browser) {
  const { names } = fake;
  await step('admin', 'admin signs in', async () => {
    ({ page: admin } = await person('admin'));
    await admin.goto(WEB);
    await admin.locator('input[name=username]').fill(ADMIN.username);
    await admin.locator('input[name=password]').fill(ADMIN.password);
    await admin.getByRole('button', { name: '로그인', exact: true }).click();
    await admin.waitForURL(`**/@${ADMIN.username}`);
  });

  await step(
    'listed',
    '/admin lists the finished studio characters, not the unfinished one',
    async () => {
      await admin.goto(`${WEB}/admin`);
      const hero = board().locator('article', { hasText: names.hero });
      await hero.getByText('완성 · 표정 적용됨').waitFor();
      await board().locator('article', { hasText: names.noWalk }).getByText('표정 준비 중').waitFor();
      // Its front render comes through the admin proxy and the character server's storage.
      if (!(await pictureLoads(hero.locator('img')))) throw new Error('the character picture did not load');
      await board().getByRole('button', { name: /^전체/ }).click();
      if (await board().getByText(names.unfinished).count()) throw new Error('an unfinished character is offered');
    },
    ['admin'],
  );

  await step(
    'imported',
    'admin imports it; the import finishes with a report without errors',
    async () => {
      const card = board().locator('article', { hasText: names.hero });
      await card.getByRole('button', { name: '가져오기', exact: true }).click();
      await card.locator('input[name=id]').fill(ITEM);
      const item = await importFrom(card, '가져오기 시작');
      if (item.status !== 'done') throw new Error(`import failed: ${item.errorMessage}`);
      const errors = levels(item.report, 'error');
      if (errors.length) throw new Error(`the report lists problems: ${errors.map((check) => check.message).join(' / ')}`);
      if (item.report.outcome !== 'created') throw new Error(`outcome ${item.report.outcome}`);
      const row = admin.locator('.mg-admin-import', { hasText: ITEM }).first();
      await row.getByText('새 항목으로 가져왔어요').waitFor();
      await row.getByRole('button', { name: '보고서' }).click();
      await row.locator('.mg-admin-checks li.is-ok').first().waitFor();
      if (await row.locator('.mg-admin-checks li.is-error, .mg-badge.is-error').count())
        throw new Error('the page shows problems in the report');
      await row.getByRole('button', { name: '보고서 닫기' }).click();
      const warnings = levels(item.report, 'warning').map((check) => check.message);
      return `${item.report.checks.length} checks${warnings.length ? `, warnings: ${warnings.join(' / ')}` : ''}`;
    },
    ['listed'],
  );

  await step(
    'published',
    'admin publishes it and it joins the public 미니미 list',
    async () => {
      const drafts = admin.getByRole('region', { name: '초안', exact: true });
      const patched = admin.waitForResponse(
        (response) => response.url().endsWith(`/api/catalog/admin/items/${ITEM}`) && response.request().method() === 'PATCH',
      );
      await drafts.locator('article', { hasText: ITEM }).getByRole('button', { name: '공개', exact: true }).click();
      if ((await patched).status() !== 200) throw new Error('publishing failed');
      await admin.getByRole('region', { name: '공개', exact: true }).getByText(names.hero).waitFor();
      const { items } = await json(admin, '/api/catalog/items?kind=minime');
      modelUrl = items.find((item) => item.id === ITEM)?.modelUrl ?? '';
      if (!/^\/models\/[0-9a-f]{64}\.glb$/.test(modelUrl)) throw new Error(`public item model "${modelUrl}"`);
      await admin.evaluate(() => window.scrollTo(0, 0));
      await shoot(admin, 'admin-imported');
      return modelUrl;
    },
    ['imported'],
  );

  await step(
    'studio',
    'admin studio: the asset library shows the studio jobs',
    async () => {
      await admin.goto(`${WEB}/studio`);
      await admin.locator('.mg-studio-connection', { hasText: '기록 바꾸기까지' }).waitFor();
      await admin.getByRole('navigation', { name: '캐릭터 스튜디오' }).getByRole('link', { name: '에셋 라이브러리' }).click();
      const gallery = admin.locator('.asset-gallery');
      for (const name of Object.values(names)) await gallery.locator('.asset-gallery-card', { hasText: name }).first().waitFor();
      const hero = gallery.locator('.asset-gallery-card', { hasText: names.hero }).first();
      if (!(await pictureLoads(hero.locator('img').first()))) throw new Error('the body picture did not load');
      await hero.locator('.asset-model-stats dl').waitFor();
      await gallery.getByRole('button', { name: '캐릭터 조합' }).click();
      await gallery.locator('.asset-character-card', { hasText: names.hero }).waitFor();
      if (await admin.locator('.workspace-error, .asset-gallery [role=alert]').count())
        throw new Error('the workspace shows an error');
      await shoot(admin, 'admin-studio');
    },
    ['admin'],
  );

  await step(
    'making',
    'admin studio: the photo, body and parts screens read the same jobs',
    async () => {
      const screens = [
        // The stage runner lists what each stage could redo.
        ['사진으로 전체 생성', admin.locator('.studio-root button[data-recommended]').first()],
        ['기본몸', admin.locator('.wardrobe-body', { hasText: names.hero })],
        // The common body is loaded and dressed in its saved outfit.
        ['파츠', admin.locator('.assembly-preview:not([data-assembly-ready=""])')],
      ];
      for (const [screen, ready] of screens) {
        await admin.getByRole('navigation', { name: '캐릭터 스튜디오' }).getByRole('link', { name: screen }).click();
        await ready.waitFor({ timeout: 60_000 });
        const alerts = await admin.locator('.studio-root [role=alert]').allInnerTexts();
        if (alerts.length) throw new Error(`${screen}: ${alerts.join(' / ')}`);
      }
      await shoot(admin, 'admin-studio-parts');
    },
    ['studio'],
  );

  await step('member', 'a new member signs up and reaches their island', async () => {
    ({ page: member, sent: memberSent } = await person('member'));
    await member.goto(WEB);
    await member.getByRole('tab', { name: '가입하기' }).click();
    await member.locator('input[name=username]').fill(MEMBER.username);
    await member.locator('input[name=displayName]').fill(MEMBER.displayName);
    await member.locator('input[name=password]').fill(MEMBER.password);
    await member.getByRole('button', { name: '가입하고 내 섬 만들기' }).click();
    await member.waitForURL(`**/@${MEMBER.username}`);
    await worldReady(member);
  });

  await step(
    'switched',
    'member switches their 미니미 to it and the island loads its model',
    async () => {
      await member.getByRole('tab', { name: '소개' }).click();
      const model = member.waitForResponse((response) => new URL(response.url()).pathname === modelUrl, { timeout: 60_000 });
      const saved = member.waitForResponse(
        (response) => response.url().endsWith('/api/homes/me') && response.request().method() === 'PATCH',
      );
      await member.locator('.mg-minimes button', { hasText: names.hero }).click();
      if ((await saved).status() !== 200) throw new Error('the choice was not saved');
      const response = await model;
      const type = response.headers()['content-type'];
      if (response.status() !== 200 || type !== 'model/gltf-binary')
        throw new Error(`${modelUrl} answered ${response.status()} ${type}`);
      await member.locator('.mg-minimes button[aria-pressed=true]', { hasText: names.hero }).waitFor();
    },
    ['published', 'member'],
  );

  await step(
    'reloaded',
    'the choice survives a reload and the island opens with that model',
    async () => {
      const from = memberSent.length;
      await member.reload();
      await worldReady(member);
      const statuses = await member.evaluate(
        (path) =>
          performance
            .getEntriesByType('resource')
            .filter((entry) => new URL(entry.name).pathname === path)
            .map((entry) => entry.responseStatus),
        modelUrl,
      );
      if (!statuses.includes(200))
        throw new Error(`the island did not load ${modelUrl} (${statuses.join(', ') || 'no request'})`);
      // Others in the live room are told to show the same model.
      const join = await until(
        () => memberSent.slice(from).find((message) => message.type === 'Join'),
        30_000,
        'joining the live room',
      );
      if (!String(join.modelUrl).endsWith(modelUrl)) throw new Error(`the live room was told ${join.modelUrl}`);
      await member.getByRole('tab', { name: '소개' }).click();
      await member.locator('.mg-minimes button[aria-pressed=true]', { hasText: names.hero }).waitFor();
    },
    ['switched'],
  );

  /** The last position the island reported to the live room after message `from`. */
  const position = (from = 0) =>
    memberSent.slice(from).findLast((message) => message.type === 'Update' && message.state?.position)?.state.position;
  await step(
    'walked',
    'member walks the island with the keyboard',
    async () => {
      // Keys move the player while the world has focus, as after tabbing into it.
      await member.locator('.mg-world-canvas canvas').focus();
      await until(() => position(), 10_000, 'a position from the island');
      const before = position();
      const from = memberSent.length;
      await member.keyboard.down('KeyW');
      await member.waitForTimeout(2500);
      await member.keyboard.up('KeyW');
      const after = await until(() => position(from), 5_000, 'a position after walking');
      const moved = Math.hypot(after[0] - before[0], after[2] - before[2]);
      if (moved < 1) throw new Error(`moved only ${moved.toFixed(2)} m`);
      await shoot(member, 'member-island');
      return `${moved.toFixed(1)} m`;
    },
    ['reloaded'],
  );

  await step(
    'wardrobe',
    'member opens /studio and gets only the wardrobe',
    async () => {
      await member.goto(`${WEB}/studio`);
      const scene = member.locator('.wardrobe-scene');
      // The body model is loaded and posed once the clip buttons are enabled.
      await member
        .getByRole('button', { name: 'walk', exact: true })
        .and(member.locator(':enabled'))
        .waitFor({ timeout: 60_000 });
      const renderer = await scene.getAttribute('data-renderer');
      if (await member.locator('.studio-shell, .asset-gallery, .mg-studio-connection').count())
        throw new Error('a member sees the admin workspace');
      // Every screen but the wardrobe is marked locked.
      const nav = member.getByRole('navigation', { name: '캐릭터 스튜디오' });
      const [links, locked] = [await nav.getByRole('link').count(), await nav.locator('a.is-locked').count()];
      if (locked !== links - 1) throw new Error(`${locked} of ${links} studio links are locked`);
      await shoot(member, 'member-wardrobe');
      await member.goto(`${WEB}/studio/library`);
      await member.getByText('운영자만 쓰는 화면이에요').waitFor();
      if (await member.locator('.studio-shell').count()) throw new Error('the library opened for a member');
      const direct = await member.request.get(`${WEB}/api/avatar-factory/jobs`);
      if (direct.status() !== 403) throw new Error(`a member reading the studio jobs got ${direct.status()}`);
      return `renderer ${renderer}`;
    },
    ['member'],
  );

  await step(
    'reimported',
    're-importing the remade character keeps it public as a new version',
    async () => {
      await fake.reseal(names.hero);
      await admin.goto(`${WEB}/admin`);
      const card = board().locator('article', { hasText: names.hero });
      await card.getByText(/새 버전 있음/).waitFor();
      await card.getByRole('button', { name: '업데이트', exact: true }).click();
      const item = await importFrom(card, '업데이트 시작');
      if (item.status !== 'done' || item.report.outcome !== 'updated')
        throw new Error(`import ${item.status}, ${item.report?.outcome ?? item.errorMessage}`);
      if (levels(item.report, 'error').length) throw new Error('the report lists problems');
      const { items } = await json(admin, '/api/catalog/admin/items');
      const kept = items.find((entry) => entry.id === ITEM);
      if (kept?.status !== 'published' || kept.versionCount !== 2)
        throw new Error(`item is ${kept?.status} with ${kept?.versionCount} versions`);
      if (kept.label !== names.hero) throw new Error(`the item was renamed to ${kept.label}`);
      if (kept.modelUrl === modelUrl) throw new Error('the item still shows the first model');
      const { items: shown } = await json(admin, '/api/catalog/items?kind=minime');
      if (shown.find((entry) => entry.id === ITEM)?.modelUrl !== kept.modelUrl)
        throw new Error('the public list does not show the new model');
      await admin.locator('.mg-admin-import', { hasText: ITEM }).first().getByText('모델을 새 버전으로 바꿨어요').waitFor();
      await admin.getByRole('region', { name: '공개', exact: true }).getByText(names.hero).waitFor();
    },
    ['published'],
  );

  await step(
    'refused',
    'a character without a walk clip is refused with a readable reason',
    async () => {
      await admin.goto(`${WEB}/admin`);
      const card = board().locator('article', { hasText: names.noWalk });
      await card.getByRole('button', { name: '가져오기', exact: true }).click();
      await card.locator('input[name=id]').fill(REFUSED_ITEM);
      const item = await importFrom(card, '가져오기 시작');
      if (item.status !== 'failed' || item.errorCode !== 'not_playable')
        throw new Error(`import ${item.status} (${item.errorCode})`);
      const clips = item.report.checks.find((check) => check.code === 'clips');
      if (clips?.level !== 'error' || !clips.message.includes('walk')) throw new Error(`clip check: ${JSON.stringify(clips)}`);
      const row = admin.locator('.mg-admin-import', { hasText: REFUSED_ITEM }).first();
      await row.getByText(item.errorMessage).waitFor();
      await row.getByRole('button', { name: '보고서' }).click();
      await row.locator('.mg-admin-checks li.is-error', { hasText: clips.message }).waitFor();
      const { items } = await json(admin, '/api/catalog/admin/items');
      if (items.some((entry) => entry.id === REFUSED_ITEM)) throw new Error('a refused character became a catalog item');
      await shoot(admin, 'admin-refused');
      return item.errorMessage;
    },
    ['admin'],
  );
}

if (fake) problems.push(...(await fake.problems().catch((error) => [`fake character server: ${error.message}`])));
const unexpected = problems.filter((problem) => !/favicon|DevTools/.test(problem));
if (unexpected.length && serverLog) {
  const tail = (() => {
    try {
      return readFileSync(serverLog, 'utf8').trim().split('\n').slice(-25).join('\n');
    } catch {
      return '';
    }
  })();
  if (tail) console.log(`\nRust server log (last lines):\n${tail}`);
}
await cleanup();
const seconds = Math.round((Date.now() - began) / 1000);
console.log(
  unexpected.length === 0
    ? `\ncharacter e2e passed in ${seconds}s; screenshots in ${SHOTS}`
    : `\n${unexpected.length} problem(s) in ${seconds}s:\n${unexpected.join('\n')}`,
);
process.exit(unexpected.length === 0 ? 0 : 1);
