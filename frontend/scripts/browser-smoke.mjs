// Opens the web app in Chromium against the running server: sign up, reach the new island, wait for its first
// complete frame, decorate it (place a chair, move it with the select tool, undo and redo, checking each saved island),
// then visit it as a second member, talk, and leave a guestbook entry. Both accounts are made with a password generated
// for this run.
// Usage: node scripts/browser-smoke.mjs [webUrl] [screenshotDir] [--allow-remote]   (a local server; it creates accounts)
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const allowRemote = args.includes('--allow-remote');
const [WEB = 'http://127.0.0.1:5180', SHOTS = '.data/screenshots'] = args.filter((arg) => arg !== '--allow-remote');
const { hostname } = new URL(WEB);
if (!allowRemote && !/^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(hostname)) {
  console.error(`${WEB} is not a loopback address, and this script signs up accounts there. Pass --allow-remote to run it anyway.`);
  process.exit(1);
}
const WORLD_READY_MS = 120_000;

mkdirSync(SHOTS, { recursive: true });
const suffix = randomBytes(3).toString('hex');
const PASSWORD = randomBytes(16).toString('hex');
const SCREENSHOT = { timeout: 90_000, animations: 'disabled' };
const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
});
const problems = [];

async function member(username, name) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(`${username} pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`${username} console: ${message.text().slice(0, 300)}`);
  });
  await page.goto(WEB);
  await page.getByRole('tab', { name: '가입하기' }).click();
  await page.locator('input[name=username]').fill(username);
  await page.locator('input[name=displayName]').fill(name);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.getByRole('button', { name: '가입하고 내 섬 만들기' }).click();
  await page.waitForURL(`**/@${username}`);
  return page;
}

const step = async (label, run) => {
  const started = Date.now();
  try {
    await run();
    console.log(`ok   ${label} (${Date.now() - started}ms)`);
  } catch (error) {
    problems.push(`${label}: ${error.message.split('\n')[0]}`);
    console.log(`FAIL ${label}: ${error.message.split('\n')[0]}`);
  }
};

// The loading cover stays only ~600 ms after the island is ready, which a busy page can skip past unseen; its being gone
// (with the island there) is a state that stays.
const worldReady = (page) =>
  page.waitForFunction(() => document.querySelector('.mg-world') && !document.querySelector('.mg-world-loading'), undefined, {
    timeout: WORLD_READY_MS,
    polling: 250,
  });
const saved = (page) =>
  page
    .waitForResponse((response) => response.url().endsWith('/api/homes/me/world') && response.request().method() === 'PUT')
    .catch((error) => error);

const ownerName = `smoke_${suffix}`;
let owner;
await step('owner signs up and lands on the new island', async () => {
  owner = await member(ownerName, '스모크');
  await owner.getByRole('heading', { name: /스모크의 섬/ }).waitFor();
});
await step('island reaches its first complete frame', async () => {
  await worldReady(owner);
  await owner.waitForTimeout(1500);
  await owner.screenshot({ ...SCREENSHOT, path: join(SHOTS, 'owner-home.png') });
});
/** Saves with the 저장 button and returns where the pieces this run placed stand in the saved island. */
async function saveAndRead(page) {
  const response = saved(page);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const answer = await response;
  if (answer instanceof Error) throw answer;
  if (answer.status() !== 200) throw new Error(`save answered ${answer.status()}`);
  const objects = answer.request().postDataJSON()?.data?.domains?.building?.objects ?? [];
  return objects
    .filter((object) => object.id.startsWith('obj-'))
    .map((object) => `${object.config?.modelId}@${object.position.x},${object.position.z}`)
    .join(' ');
}
const same = (label, actual, expected) => {
  if (actual !== expected) throw new Error(`${label}: expected "${expected}", saved "${actual}"`);
};
let placedAt = '';
let movedTo = '';
let chairSpot = { x: 0, y: 0 };
await step('owner decorates: places a chair and saves the island', async () => {
  await owner.getByRole('link', { name: '꾸미기' }).click();
  await owner.waitForURL(`**/@${ownerName}/edit`);
  // The island stays loaded: decorating is a mode of the same world.
  await owner.locator('.mg-drawer').waitFor();
  await owner.screenshot({ ...SCREENSHOT, path: join(SHOTS, 'owner-decorate.png') });
  await owner.getByRole('button', { name: '의자' }).click();
  const canvas = await owner.locator('.mg-world-canvas canvas').boundingBox();
  const spot = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height * 0.45 };
  await owner.mouse.click(spot.x, spot.y);
  await owner.getByRole('button', { name: '되돌리기' }).and(owner.locator(':enabled')).waitFor({ timeout: 10_000 });
  placedAt = await saveAndRead(owner);
  if (!placedAt.startsWith('chair-basic@')) throw new Error(`no chair in the saved island: "${placedAt}"`);
  chairSpot = spot;
});
await step('owner moves the chair with the select tool, then undoes and redoes it', async () => {
  const spot = chairSpot;
  await owner.getByRole('button', { name: /^선택/ }).click();
  await owner.mouse.click(spot.x, spot.y);
  await owner.locator('.mg-inspector header b', { hasText: '의자' }).waitFor({ timeout: 10_000 });
  await owner.mouse.move(spot.x, spot.y);
  await owner.mouse.down();
  for (let i = 1; i <= 10; i++) await owner.mouse.move(spot.x + i * 16, spot.y + i * 3);
  await owner.mouse.up();
  movedTo = await saveAndRead(owner);
  if (movedTo === placedAt) throw new Error(`the chair did not move from ${placedAt}`);
  await owner.screenshot({ ...SCREENSHOT, path: join(SHOTS, 'owner-moved.png') });
  await owner.getByRole('button', { name: '되돌리기' }).click();
  same('undo', await saveAndRead(owner), placedAt);
  await owner.getByRole('button', { name: '다시 하기' }).click();
  same('redo', await saveAndRead(owner), movedTo);
  await owner.getByRole('button', { name: '나가기' }).click();
  await owner.waitForURL(`**/@${ownerName}`);
  await owner.locator('.mg-side').waitFor();
});
await step('owner changes the mood', async () => {
  await owner.getByRole('tab', { name: '소개' }).click();
  const patched = owner
    .waitForResponse((response) => response.url().endsWith('/api/homes/me') && response.request().method() === 'PATCH')
    .catch((error) => error);
  await owner.getByRole('radio', { name: /설렘/ }).click();
  const response = await patched;
  if (response instanceof Error) throw response;
  if (response.status() !== 200) throw new Error('mood not saved');
  await owner.getByRole('tab', { name: '방명록' }).click();
});

const guestName = `guest_${suffix}`;
let guest;
await step('a second member visits and cannot decorate', async () => {
  guest = await member(guestName, '손님');
  await guest.goto(`${WEB}/@${ownerName}/edit`);
  await guest.waitForURL(`**/@${ownerName}`);
  await guest.getByText('놀러 옴').waitFor();
  if (await guest.locator('.mg-drawer').count()) throw new Error('visitor sees the decorating drawer');
  await worldReady(guest);
  await guest.waitForTimeout(1500);
  await guest.screenshot({ ...SCREENSHOT, path: join(SHOTS, 'guest-visit.png') });
});
await step('owner and visitor meet in the live room', async () => {
  await guest.getByText('함께 2명').waitFor({ timeout: 30_000 });
  await owner.getByText('함께 2명').waitFor({ timeout: 30_000 });
});
await step('visitor says hello to whoever is near', async () => {
  const say = guest.getByRole('textbox', { name: '말하기' });
  await say.fill('안녕하세요!');
  await say.press('Enter');
  await guest.locator('.mg-chatbar-said', { hasText: '안녕하세요!' }).waitFor();
  await owner.screenshot({ ...SCREENSHOT, path: join(SHOTS, 'owner-with-visitor.png') });
});
await step('visitor writes in the guestbook', async () => {
  await guest.getByRole('tab', { name: '방명록' }).click();
  await guest.getByPlaceholder('따뜻한 한마디').fill('섬이 정말 예뻐요');
  await guest.getByRole('button', { name: '남기기' }).click();
  await guest.getByText('섬이 정말 예뻐요').waitFor();
  await guest.screenshot({ ...SCREENSHOT, path: join(SHOTS, 'guest-guestbook.png') });
});
await step('visitor asks to be neighbors', async () => {
  await guest.getByRole('tab', { name: /^이웃/ }).click();
  await guest.getByRole('button', { name: '이웃 신청' }).click();
  await guest.locator('input[name=name]').fill('섬주인');
  await guest.locator('input[name=theirName]').fill('단골');
  await guest.locator('.mg-side').getByRole('button', { name: '보내기' }).click();
  await guest.getByText('이웃 신청을 보냈어요').waitFor();
});
await step('owner accepts it and sees the visit counted', async () => {
  await owner.reload();
  await owner.getByRole('tab', { name: /^이웃/ }).click();
  await owner.locator('.mg-side').getByRole('button', { name: '수락' }).click();
  await owner.locator('.mg-people li', { hasText: '손님' }).getByRole('link', { name: '놀러가기' }).waitFor();
  await owner.getByText('오늘 방문 1').waitFor();
  await owner.screenshot({ ...SCREENSHOT, path: join(SHOTS, 'owner-neighbors.png') });
});

await browser.close();
const unexpected = problems.filter((problem) => !/favicon|DevTools/.test(problem));
console.log(
  unexpected.length === 0 ? '\nbrowser smoke passed' : `\n${unexpected.length} problem(s):\n${unexpected.join('\n')}`,
);
process.exit(unexpected.length === 0 ? 0 : 1);
