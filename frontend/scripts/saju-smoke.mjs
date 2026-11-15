// Walks the 사주 village in Chrome against the running server, as two new members: the card that builds a home (a lunar
// birth) and its guardian dog, the home filling the window, a drag that turns the picture, the buttons and the wheel
// that zoom it, the story panel folding away, its saved picture, BGM, 사주보기, the village, a visit, the guestbook,
// 이웃 and the bridge between them, 파도타기, a click on the map, entering the 사주 again and taking the home down.
// Both accounts are made with a password generated for this run.
// Usage: node scripts/saju-smoke.mjs [webUrl] [screenshotDir] [--allow-remote] [--flag]   (a local server; it creates accounts)
// --flag also raises the village's flag: nine more members are signed up over the API and become the first member's
// 이웃. The server takes twenty sign-ups from one address in ten minutes, so this walk runs once in that time.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';
import sharp from 'sharp';

const args = process.argv.slice(2);
const allowRemote = args.includes('--allow-remote');
const raiseFlag = args.includes('--flag');
const [WEB = 'http://127.0.0.1:5180', SHOTS = '.data/saju-smoke'] = args.filter((arg) => !arg.startsWith('--'));
const { hostname } = new URL(WEB);
if (!allowRemote && !/^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(hostname)) {
  console.error(`${WEB} is not a loopback address, and this script signs up accounts there. Pass --allow-remote to run it anyway.`);
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });
const suffix = randomBytes(3).toString('hex');
const PASSWORD = randomBytes(16).toString('hex');

// Chrome on this machine's GPU: a software renderer takes minutes over the village.
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])],
});
const problems = [];
/** The guardian dogs' models each page has fetched, and whether each arrived: a dog is fetched once and then shared. */
const dogs = new Map();

async function member(username, name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  dogs.set(page, []);
  page.on('response', (response) => {
    if (/\/gltf\/guardians\/\d{2}\.glb$/.test(new URL(response.url()).pathname)) dogs.get(page).push(response.ok());
  });
  page.on('pageerror', (error) => problems.push(`${username} pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`${username} console: ${message.text().slice(0, 300)}`);
  });
  await page.goto(WEB);
  await page.getByRole('tab', { name: '가입하기' }).click();
  await page.locator('input[name=username]').fill(username);
  await page.locator('input[name=displayName]').fill(name);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
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
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
/** The canvas shows once its first frames are drawn; the camera then takes about a second to settle. */
const settled = async (page) => {
  await page.waitForSelector('.mg-saju-canvas[data-drawn]', { timeout: 120_000 });
  await page.waitForTimeout(1800);
};
const heading = (page, name) => page.getByRole('heading', { name }).waitFor();
/** How far two screenshots of one size are apart: the mean difference of their colour values, 0 (the same) to 255. */
async function difference(one, other) {
  const [a, b] = await Promise.all([one, other].map((png) => sharp(png).removeAlpha().raw().toBuffer()));
  if (a.length !== b.length) return 255;
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += Math.abs(a[index] - b[index]);
  return sum / a.length;
}
async function build(page, name, { calendar, year, month, day, time, gender }) {
  await page.locator('input[name=name]').fill(name);
  await page.getByRole('radio', { name: calendar }).click();
  await page.locator('input[name=year]').fill(String(year));
  await page.locator('input[name=month]').fill(String(month));
  await page.locator('input[name=day]').fill(String(day));
  await page.locator('input[name=time]').fill(time);
  await page.getByRole('radio', { name: gender }).click();
}

const gaonName = `gaon_${suffix}`;
const noeulName = `noeul_${suffix}`;
let gaon;
let noeul;

await step('a new member lands on the plot and the card to build a home', async () => {
  gaon = await member(gaonName, '가온');
  await heading(gaon, '내 집 짓기');
  await gaon.locator(`.mg-saju-pin[data-pin=${gaonName}]`, { hasText: '빈 터' }).waitFor();
  await settled(gaon);
  await shot(gaon, '1-first-visit');
});
await step('an incomplete card says what is missing', async () => {
  await gaon.locator('input[name=name]').fill('');
  await gaon.getByRole('button', { name: '내 집 짓기' }).click();
  await gaon.getByRole('alert').filter({ hasText: '이름을 적어 주세요' }).waitFor();
});
await step('a lunar birth builds the home on the server', async () => {
  await build(gaon, '가온', { calendar: '음력', year: 1993, month: 3, day: 15, time: '07:40', gender: '여성' });
  // 1993 has a leap third month: the checkbox for it appears.
  await gaon.getByRole('checkbox', { name: '윤달' }).waitFor();
  const saved = gaon.waitForResponse((response) => response.url().endsWith('/api/homes/me/saju') && response.request().method() === 'PUT');
  await gaon.getByRole('button', { name: '내 집 짓기' }).click();
  if (!(await saved).ok()) throw new Error('the server refused the home');
  await heading(gaon, '가온의 미니홈피');
  // The home's guardian is one of the twenty dogs. The picture waits for its model, which this page fetched now or,
  // when a home of the village around the empty plot had the same dog, before the home was built.
  await gaon.locator('.mg-saju-notes', { hasText: '강아지' }).waitFor();
  await settled(gaon);
  const fetched = dogs.get(gaon);
  if (!fetched.length || fetched.includes(false)) throw new Error(`the guardian dogs' models did not all arrive (${fetched.filter(Boolean).length} of ${fetched.length})`);
  await shot(gaon, '2-home');
  // It is the server's: a reload finds it.
  await gaon.reload();
  await heading(gaon, '가온의 미니홈피');
  await gaon.locator('.mg-saju-badge').waitFor();
});
await step('the picture fills the window, under the page\'s glass', async () => {
  const { width, height } = gaon.viewportSize();
  const box = await gaon.locator('.mg-saju-canvas').boundingBox();
  if (box.x !== 0 || box.y !== 0 || box.width !== width || box.height !== height) throw new Error(`the canvas is ${box.width}x${box.height} at ${box.x},${box.y} in a ${width}x${height} window`);
  if (await gaon.evaluate(() => document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth)) throw new Error('the page scrolls');
});
// For a viewer who asked for less motion the scene holds still but for a little grain from frame to frame, so a picture
// that changed much more than that was turned or zoomed. The first member's own page asks for it through these steps:
// a second page drawing beside it would take the graphics card from both.
const canvasOf = (page) => page.locator('.mg-saju-canvas canvas').screenshot();
/** The picture once it has stopped changing (a slow machine gives up some of its look a few seconds in), and how much it still does. */
async function steady(page) {
  let before = await canvasOf(page);
  for (let tries = 0; tries < 12; tries++) {
    await page.waitForTimeout(700);
    const now = await canvasOf(page);
    const idle = await difference(before, now);
    if (idle < 1.5) return { picture: now, idle };
    before = now;
  }
  throw new Error('the still picture kept changing');
}
/** Whether the picture is far from `from`: well past what it changes by when left alone. */
const movedFrom = async (page, { picture, idle }) => (await difference(picture, await canvasOf(page))) >= Math.max(2, idle * 8);
await step('a drag to the side turns the picture and visits nothing', async () => {
  await gaon.emulateMedia({ reducedMotion: 'reduce' });
  await gaon.reload();
  await settled(gaon);
  const box = await gaon.locator('.mg-saju-canvas').boundingBox();
  const still = await steady(gaon);
  // Over the open water, left of the story panel.
  await gaon.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await gaon.mouse.down();
  for (let moved = 1; moved <= 20; moved++) {
    await gaon.mouse.move(box.x + box.width * 0.5 - moved * 12, box.y + box.height * 0.5);
    await gaon.waitForTimeout(16);
  }
  await gaon.mouse.up();
  await gaon.waitForTimeout(800);
  if (!(await movedFrom(gaon, still))) throw new Error('the picture did not turn');
  if (!gaon.url().endsWith(`/@${gaonName}`)) throw new Error(`the drag went to ${gaon.url()}`);
  await shot(gaon, '3-turned');
});
await step('the buttons and the wheel zoom the picture in and out', async () => {
  try {
    const box = await gaon.locator('.mg-saju-canvas').boundingBox();
    const fitted = await steady(gaon);
    await gaon.getByRole('button', { name: '확대' }).click();
    await gaon.getByRole('button', { name: '확대' }).click();
    await gaon.waitForTimeout(600);
    if (!(await movedFrom(gaon, fitted))) throw new Error('the button did not zoom in');
    await shot(gaon, '3-zoomed-in');
    const closer = await steady(gaon);
    // A third of the way back out: short of the farthest the picture goes, so the button after it still has room.
    await gaon.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await gaon.mouse.wheel(0, 300);
    await gaon.waitForTimeout(600);
    if (!(await movedFrom(gaon, closer))) throw new Error('the wheel did not zoom out');
    if (await gaon.evaluate(() => scrollY !== 0)) throw new Error('the wheel scrolled the page');
    const farther = await steady(gaon);
    await gaon.getByRole('button', { name: '축소' }).click();
    await gaon.waitForTimeout(600);
    if (!(await movedFrom(gaon, farther))) throw new Error('the button did not zoom out');
    await shot(gaon, '3-zoomed-out');
  } finally {
    await gaon.emulateMedia({ reducedMotion: null });
    await gaon.reload();
    await heading(gaon, '가온의 미니홈피');
  }
});
await step('the story panel folds away and comes back', async () => {
  await gaon.getByRole('button', { name: '패널 접기' }).click();
  await gaon.locator('.mg-saju-panel').waitFor({ state: 'hidden' });
  await shot(gaon, '3-folded');
  await gaon.getByRole('button', { name: '가온의 이야기' }).click();
  await gaon.locator('.mg-saju-panel').waitFor({ state: 'visible' });
});
await step('the picture saves as a PNG', async () => {
  const [download] = await Promise.all([gaon.waitForEvent('download', { timeout: 30_000 }), gaon.getByRole('button', { name: '내 집 이미지 저장하기' }).click()]);
  if (download.suggestedFilename() !== '가온-집.png') throw new Error(`file name: ${download.suggestedFilename()}`);
  await download.saveAs(join(SHOTS, '4-saved-picture.png'));
  await gaon.getByText('이미지를 저장했어요').waitFor();
});
await step('the BGM plays and stops', async () => {
  await gaon.getByRole('button', { name: 'BGM 재생' }).click();
  await gaon.getByRole('button', { name: 'BGM 멈춤' }).waitFor();
  await gaon.waitForTimeout(1200);
  await gaon.getByRole('button', { name: 'BGM 멈춤' }).click();
  await gaon.getByRole('button', { name: 'BGM 재생' }).waitFor();
});
await step('사주보기 shows the chart', async () => {
  await gaon.getByRole('link', { name: '사주보기' }).click();
  await heading(gaon, '사주 원국');
  await shot(gaon, '5-chart');
});
await step('a second member builds a home and finds the first in their village', async () => {
  noeul = await member(noeulName, '노을');
  await heading(noeul, '내 집 짓기');
  await build(noeul, '노을', { calendar: '양력', year: 1987, month: 6, day: 17, time: '08:30', gender: '남성' });
  await noeul.getByRole('button', { name: '내 집 짓기' }).click();
  await heading(noeul, '노을의 미니홈피');
  await noeul.getByRole('link', { name: '마을', exact: true }).click();
  await noeul.locator(`.mg-saju-villager[href="/@${gaonName}"]`).waitFor();
  await settled(noeul);
  await shot(noeul, '6-village');
});
await step('a visit leaves a line in the guestbook and asks to be 이웃', async () => {
  await noeul.locator(`.mg-saju-villager[href="/@${gaonName}"]`).click();
  await heading(noeul, '가온의 미니홈피');
  await noeul.locator('#guestbook-text').fill('집 구경 왔어요');
  await noeul.getByRole('button', { name: '남기기' }).click();
  await noeul.locator('.mg-entries li').first().getByText('집 구경 왔어요').waitFor();
  await noeul.getByRole('button', { name: '이웃 신청' }).click();
  await noeul.locator('input[name=name]').fill('옆집');
  await noeul.locator('input[name=theirName]').fill('앞집');
  await noeul.getByRole('button', { name: '보내기' }).click();
  await noeul.getByText('이웃 신청을 보냈어요').waitFor();
});
await step('the owner reads the line, accepts, and a bridge joins the two homes', async () => {
  await gaon.goto(`${WEB}/@${gaonName}`);
  await gaon.locator('.mg-entries li').first().getByText('집 구경 왔어요').waitFor();
  await gaon.locator('.mg-saju-bridge').getByRole('button', { name: '수락' }).click();
  await gaon.locator('.mg-saju-bridge').waitFor({ state: 'detached' });
  await gaon.getByRole('link', { name: '마을', exact: true }).click();
  await gaon.locator(`.mg-saju-villager[href="/@${noeulName}"]`).getByText('이웃').waitFor();
  await settled(gaon);
  await shot(gaon, '7-neighbours');
});
await step('the visitor sees what 궁합 found and the two homes with the bridge', async () => {
  await noeul.reload();
  await noeul.locator('.mg-saju-bridge-line').waitFor();
  await settled(noeul);
  await noeul.getByRole('button', { name: '다리 보기' }).click();
  await noeul.locator('.mg-saju-say').waitFor();
  await noeul.waitForTimeout(3200);
  await shot(noeul, '8-bridge');
  await noeul.getByRole('button', { name: '집 보기' }).click();
  await noeul.locator('.mg-saju-say').waitFor({ state: 'detached' });
});
if (raiseFlag) {
  await step('ten 이웃 raise the village\'s flag', async () => {
    const headers = { origin: new URL(WEB).origin };
    // The second member is one already; nine more ask, each from a session of their own, and the first accepts them all.
    for (let index = 0; index < 9; index++) {
      const session = await browser.newContext();
      try {
        const username = `nb${index}_${suffix}`;
        const signUp = await session.request.post(`${WEB}/api/auth/register`, { headers, data: { username, displayName: `이웃${index + 1}`, password: PASSWORD } });
        if (!signUp.ok()) throw new Error(`sign-up ${signUp.status()} (twenty an address in ten minutes)`);
        const asked = await session.request.post(`${WEB}/api/ilchon/${gaonName}/request`, { headers, data: { name: '이웃', theirName: '이웃', message: '' } });
        if (!asked.ok()) throw new Error(`request ${asked.status()}`);
      } finally {
        await session.close();
      }
    }
    const { received } = await (await gaon.request.get(`${WEB}/api/ilchon-requests`)).json();
    for (const request of received) {
      const accepted = await gaon.request.post(`${WEB}/api/ilchon-requests/${request.id}/accept`, { headers, data: {} });
      if (!accepted.ok()) throw new Error(`accept ${accepted.status()}`);
    }
    await gaon.goto(`${WEB}/@${gaonName}/village`);
    await gaon.locator('.mg-saju-flag[data-raised]', { hasText: '이웃 10명' }).waitFor();
    await settled(gaon);
    await shot(gaon, '8-flag');
  });
}
await step('파도타기 goes on to a home of the village', async () => {
  await gaon.getByRole('link', { name: '파도타기' }).click();
  await gaon.waitForURL((url) => url.pathname.startsWith('/@') && url.pathname !== `/@${gaonName}/village`);
  await gaon.locator('.mg-saju-bar-title').waitFor();
});
await step('a click on an island of the map visits it', async () => {
  await gaon.goto(`${WEB}/@${gaonName}/village`);
  await settled(gaon);
  // The label over the neighbour's island marks where the island is drawn.
  const pin = await gaon.locator(`.mg-saju-pin[data-pin=${noeulName}]`).boundingBox();
  await gaon.mouse.click(pin.x + pin.width / 2, pin.y + pin.height + 60);
  await gaon.waitForURL(`**/@${noeulName}`, { timeout: 5000 });
  await heading(gaon, '노을의 미니홈피');
});
await step('the 사주 is entered again and the home taken down', async () => {
  await gaon.getByRole('link', { name: '내 집' }).click();
  await gaon.getByRole('link', { name: '사주 다시 입력' }).click();
  await heading(gaon, '사주 다시 입력');
  await gaon.getByRole('checkbox', { name: '모름' }).check();
  await gaon.getByRole('button', { name: '다시 짓기' }).click();
  await gaon.waitForURL(`**/@${gaonName}`);
  await settled(gaon);
  await shot(gaon, '9-without-hour');
  await gaon.getByRole('link', { name: '사주 다시 입력' }).click();
  gaon.once('dialog', (dialog) => dialog.accept());
  await gaon.getByRole('button', { name: '집 허물기' }).click();
  await heading(gaon, '내 집 짓기');
  // The guestbook and 이웃 outlive the home.
  await noeul.goto(`${WEB}/@${gaonName}`);
  await noeul.locator('.mg-saju-badge', { hasText: '빈 터' }).waitFor();
  await noeul.locator('.mg-entries li').first().getByText('집 구경 왔어요').waitFor();
  await noeul.getByText('이웃 · 나의 옆집').waitFor();
});
await step('an address of the village\'s first days leads to the member\'s own home', async () => {
  await noeul.goto(`${WEB}/saju/village`);
  await noeul.waitForURL(`**/@${noeulName}/village`);
});

await browser.close();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`\nSaju smoke passed. Screenshots: ${SHOTS}`);
