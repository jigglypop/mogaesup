// Walks the 사주 village in Chromium as a first-time visitor: the card that builds a home (a lunar birth), the home and
// its saved picture, BGM, 사주보기, the village, a neighbour's guestbook, the bridge, 파도타기, a click on the map, and
// correcting and taking the home down. The village keeps everything in the browser, so only the web has to be running
// (`npm run dev -w frontend`); the API may be down.
// Usage: node scripts/saju-smoke.mjs [webUrl] [screenshotDir]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';

const [WEB = 'http://127.0.0.1:5180', SHOTS = '.data/saju-smoke'] = process.argv.slice(2);
mkdirSync(SHOTS, { recursive: true });

// Chrome on this machine's GPU, as scripts/browser-smoke.mjs runs it.
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  // Without the server the app's own requests fail; the village does not make any.
  if (message.type() === 'error' && !/Failed to load resource|\/api\//.test(message.text())) problems.push(`console: ${message.text().slice(0, 300)}`);
});

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
const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
/** The camera takes about a second to settle on what a page shows. */
const settled = () => page.waitForTimeout(1800);

await step('first visit shows the village and the card to build a home', async () => {
  await page.goto(`${WEB}/saju`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '내 집 짓기' }).waitFor();
  await page.waitForSelector('.mg-saju-canvas canvas');
  await page.getByRole('link', { name: '노을' }).first().waitFor();
  await settled();
  await shot('1-first-visit');
});
await step('an incomplete card says what is missing', async () => {
  await page.getByRole('button', { name: '내 집 짓기' }).click();
  await page.getByRole('alert').filter({ hasText: '이름을 적어 주세요' }).waitFor();
});
await step('a lunar birth builds the home', async () => {
  await page.locator('input[name=name]').fill('가온');
  await page.getByRole('radio', { name: '음력' }).click();
  await page.locator('input[name=year]').fill('1993');
  await page.locator('input[name=month]').fill('3');
  await page.locator('input[name=day]').fill('15');
  // 1993 has a leap third month: the checkbox for it appears.
  await page.getByRole('checkbox', { name: '윤달' }).waitFor();
  await page.locator('input[name=time]').fill('07:40');
  await page.getByRole('radio', { name: '여성' }).click();
  await page.getByRole('button', { name: '내 집 짓기' }).click();
  await page.getByRole('heading', { name: '가온의 미니홈피' }).waitFor();
  await settled();
  await shot('2-home');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('saju:village') ?? 'null'));
  if (stored?.me?.name !== '가온' || stored.me.birth.calendar !== 'lunar' || stored.entries.length !== 2) throw new Error(`stored: ${JSON.stringify(stored)}`);
});
await step('the picture saves as a PNG', async () => {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.getByRole('button', { name: '내 집 이미지 저장하기' }).click()]);
  if (download.suggestedFilename() !== '가온-집.png') throw new Error(`file name: ${download.suggestedFilename()}`);
  await download.saveAs(join(SHOTS, '3-saved-picture.png'));
  await page.getByText('이미지를 저장했어요').waitFor();
});
await step('the BGM plays and stops', async () => {
  await page.getByRole('button', { name: 'BGM 재생' }).click();
  await page.getByRole('button', { name: 'BGM 멈춤' }).waitFor();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'BGM 멈춤' }).click();
  await page.getByRole('button', { name: 'BGM 재생' }).waitFor();
});
await step('사주보기 shows the chart', async () => {
  await page.getByRole('link', { name: '사주보기' }).click();
  await page.getByRole('heading', { name: '사주 원국' }).waitFor();
  await shot('4-chart');
});
await step('the village lists everyone and leads to a neighbour', async () => {
  await page.getByRole('link', { name: '마을', exact: true }).click();
  await page.getByRole('heading', { name: '주민 5' }).waitFor();
  await settled();
  await shot('5-village');
  await page.locator('.mg-saju-villager', { hasText: '노을' }).click();
  await page.getByRole('heading', { name: '노을의 미니홈피' }).waitFor();
});
await step('a line left in the guestbook shows first and can be removed', async () => {
  await page.getByRole('textbox', { name: '일촌평' }).fill('모닥불 구경 왔어요');
  await page.getByRole('button', { name: '남기기' }).click();
  const first = page.locator('.mg-saju-entries li').first();
  await first.getByText('모닥불 구경 왔어요').waitFor();
  await page.getByRole('heading', { name: '방명록 4' }).waitFor();
  await first.getByRole('button', { name: '가온의 글 삭제' }).click();
  await page.getByRole('heading', { name: '방명록 3' }).waitFor();
});
await step('the bridge is built and the two homes are shown with what 궁합 found', async () => {
  await settled();
  await page.getByRole('button', { name: '궁합 다리 연결' }).click();
  await page.locator('.mg-saju-say').waitFor();
  await page.waitForTimeout(3200);
  await shot('6-bridge');
  await page.getByRole('button', { name: '집 보기' }).click();
  await page.locator('.mg-saju-say').waitFor({ state: 'detached' });
});
await step('파도타기 goes on to the next neighbour', async () => {
  await page.getByRole('link', { name: '파도타기' }).click();
  await page.getByRole('heading', { name: '보리의 미니홈피' }).waitFor();
  await settled();
  await shot('7-wave');
});
await step('a click on an island of the map visits it', async () => {
  await page.getByRole('link', { name: '마을', exact: true }).click();
  await settled();
  // The label over 가람's island marks where the island is drawn.
  const pin = await page.locator('.mg-saju-pin[data-pin=garam]').boundingBox();
  await page.mouse.click(pin.x + pin.width / 2, pin.y + pin.height + 60);
  await page.getByRole('heading', { name: '가람의 미니홈피' }).waitFor({ timeout: 5000 });
});
await step('the home can be corrected and taken down', async () => {
  await page.getByRole('link', { name: '내 집' }).click();
  await page.getByRole('link', { name: '내 정보 고치기' }).click();
  await page.getByRole('heading', { name: '내 정보 고치기' }).waitFor();
  await page.getByRole('checkbox', { name: '모름' }).check();
  await page.getByRole('button', { name: '고쳐 짓기' }).click();
  await page.getByRole('heading', { name: '가온의 미니홈피' }).waitFor();
  await settled();
  await shot('8-without-hour');
  await page.getByRole('link', { name: '내 정보 고치기' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '집 허물기' }).click();
  await page.getByRole('heading', { name: '내 집 짓기' }).waitFor();
  if ((await page.evaluate(() => localStorage.getItem('saju:village'))) !== null) throw new Error('storage was not cleared');
});

await browser.close();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`\nSaju smoke passed. Screenshots: ${SHOTS}`);
