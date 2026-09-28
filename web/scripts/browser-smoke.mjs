// Opens the web app in Chromium against the running server: sign up, reach the new minihome, wait for the island's
// first complete frame, save it, then visit it as a second member and leave a guestbook entry.
// Usage: node scripts/browser-smoke.mjs [webUrl] [screenshotDir]
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';

const WEB = process.argv[2] ?? 'http://127.0.0.1:5180';
const SHOTS = process.argv[3] ?? '.data/screenshots';
const WORLD_READY_MS = 120_000;

mkdirSync(SHOTS, { recursive: true });
const suffix = randomBytes(3).toString('hex');
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
  await page.locator('input[name=password]').fill('smoke-password-1');
  await page.getByRole('button', { name: '가입하고 미니홈피 만들기' }).click();
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

const ownerName = `smoke_${suffix}`;
let owner;
await step('owner signs up and lands on the new minihome', async () => {
  owner = await member(ownerName, '스모크');
  await owner.getByRole('heading', { name: /스모크의 미니홈피/ }).waitFor();
});
await step('island reaches its first complete frame', async () => {
  await owner.locator('.mh-world-loading.is-done').waitFor({ state: 'attached', timeout: WORLD_READY_MS });
  await owner.waitForTimeout(1500);
  await owner.screenshot({ ...SCREENSHOT, path: join(SHOTS, 'owner-home.png') });
});
await step('owner saves the island from the decorate tab', async () => {
  await owner.getByRole('button', { name: '꾸미기' }).click();
  await owner.locator('.mh-decorate').waitFor();
  await owner.screenshot({ ...SCREENSHOT, path: join(SHOTS, 'owner-decorate.png') });
  const saved = owner
    .waitForResponse(
      (response) => response.url().endsWith('/api/homes/me/world') && response.request().method() === 'PUT',
    )
    .catch((error) => error);
  await owner.getByRole('button', { name: '완료' }).click();
  const response = await saved;
  if (response instanceof Error) throw response;
  if (response.status() !== 200) throw new Error(`save answered ${response.status()}`);
});
await step('owner changes mood and status', async () => {
  const patched = owner
    .waitForResponse((response) => response.url().endsWith('/api/homes/me') && response.request().method() === 'PATCH')
    .catch((error) => error);
  await owner.getByRole('radio', { name: '설렘' }).click();
  const response = await patched;
  if (response instanceof Error) throw response;
  if (response.status() !== 200) throw new Error('mood not saved');
});

const guestName = `guest_${suffix}`;
let guest;
await step('a second member visits and the island loads read-only', async () => {
  guest = await member(guestName, '손님');
  await guest.goto(`${WEB}/@${ownerName}`);
  await guest.getByText('방문 중').waitFor();
  const tabs = await guest.locator('.mh-tabs button').allTextContents();
  if (tabs.includes('꾸미기')) throw new Error('visitor sees the decorate tab');
  await guest.locator('.mh-world-loading.is-done').waitFor({ state: 'attached', timeout: WORLD_READY_MS });
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
  await guest.locator('.mh-live-said', { hasText: '안녕하세요!' }).waitFor();
  await owner.screenshot({ ...SCREENSHOT, path: join(SHOTS, 'owner-with-visitor.png') });
});
await step('visitor writes in the guestbook', async () => {
  await guest.getByRole('button', { name: '방명록' }).click();
  await guest.getByPlaceholder('따뜻한 한마디를 남겨 주세요').fill('섬이 정말 예뻐요');
  await guest.getByRole('button', { name: '남기기' }).click();
  await guest.getByText('섬이 정말 예뻐요').waitFor();
  await guest.screenshot({ ...SCREENSHOT, path: join(SHOTS, 'guest-guestbook.png') });
});
await step('visitor sends a 일촌 request', async () => {
  await guest.getByRole('button', { name: '일촌 신청' }).click();
  await guest.locator('input[name=name]').fill('섬주인');
  await guest.locator('input[name=theirName]').fill('단골');
  await guest.getByRole('button', { name: '보내기' }).click();
  await guest.getByText('일촌 신청을 보냈어요').waitFor();
});
await step('owner accepts it and sees the visit counted', async () => {
  await owner.reload();
  await owner.getByRole('button', { name: '수락' }).click();
  await owner.locator('.mh-friends li', { hasText: '손님' }).getByRole('button', { name: '놀러가기' }).waitFor();
  const counter = await owner.locator('.mh-counter').innerText();
  if (!/TOTAL\s*1/.test(counter.replace(/\s+/g, ' '))) throw new Error(`counter ${counter}`);
  await owner.screenshot({ ...SCREENSHOT, path: join(SHOTS, 'owner-ilchon.png') });
});

await browser.close();
const unexpected = problems.filter((problem) => !/favicon|DevTools/.test(problem));
console.log(
  unexpected.length === 0 ? '\nbrowser smoke passed' : `\n${unexpected.length} problem(s):\n${unexpected.join('\n')}`,
);
process.exit(unexpected.length === 0 ? 0 : 1);
