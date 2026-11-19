/**
 * Optional browser smoke test. Not part of `npm test` because it needs a real
 * Chrome install and a running app. Usage:
 *
 *   npm run build
 *   PORT=4173 npm start &
 *   node scripts/e2e.mjs
 *
 * Env:
 *   BASE_URL   default http://localhost:4173
 *   CHROME     path to a Chrome/Chromium binary
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:4173';
const candidates = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const executablePath = candidates.find((candidate) => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
});

if (!executablePath) {
  console.error('No Chrome/Chromium found. Set CHROME=/path/to/chrome.');
  process.exit(1);
}

const failures = [];
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
};

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

try {
  console.log('== load UI ==');
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  check(await page.getByRole('heading', { name: '精灵图集工具' }).isVisible(), 'app renders');

  if ((await page.locator('.frame-row').count()) === 0) {
    await page.getByRole('button', { name: '载入示例素材' }).click();
    await page.waitForTimeout(1200);
  }
  check((await page.locator('.frame-row').count()) > 0, 'frames imported');

  console.log('\n== multi-page pack ==');
  const numbers = page.locator('.settings-grid input[type=number]');
  for (const [index, value] of [
    [0, '160'],
    [1, '160'],
    [2, '2'],
    [3, '4'],
    [4, '1'],
  ]) {
    await numbers.nth(index).fill(value);
    await numbers.nth(index).dispatchEvent('change');
  }
  await page.getByRole('button', { name: '打包', exact: true }).click();
  await page.waitForTimeout(2500);
  const pageOptions = await page.locator('.toolbar select option').count();
  check(pageOptions >= 2, 'several pages generated', `${pageOptions} page(s)`);
  const issueText = await page.locator('.issue-list').innerText().catch(() => '');
  check(issueText.includes('FRAME_TOO_LARGE'), 'oversized frame is called out', issueText.split('\n')[0] ?? '');
  check((await page.locator('.verification li.fail').count()) === 0, 'build verification has no failures');

  console.log('\n== frame comparison ==');
  const names = await page.locator('.frame-row .frame-name').allInnerTexts();
  const pills = await page.locator('.frame-row .pill').allInnerTexts();
  const rotatedIndex = pills.findIndex((pill) => pill.includes('旋转'));
  check(rotatedIndex >= 0, 'at least one frame is packed rotated');
  await page.locator('.frame-row').nth(Math.max(0, rotatedIndex)).click();
  await page.waitForTimeout(1200);
  const compareText = await page.locator('.compare-status').innerText();
  check(compareText.startsWith('像素一致'), 'rotated frame reconstruction matches source pixels', compareText);
  console.log('ROTATED FRAME:', names[Math.max(0, rotatedIndex)], '—', compareText);

  // An unplaced frame must say so instead of showing a false match.
  const unplacedIndex = pills.findIndex((pill) => pill.includes('无法容纳'));
  if (unplacedIndex >= 0) {
    await page.locator('.frame-row').nth(unplacedIndex).click();
    await page.waitForTimeout(900);
    const unplacedText = await page.locator('.compare-status').innerText();
    check(unplacedText.includes('未放置'), 'unplaced frame explains why it has no atlas position', unplacedText.slice(0, 80));
  }

  console.log('\n== animation across pages ==');
  for (const target of ['slash.png', 'hero_run_1.png', 'hero_run_2.png', 'tiny_dot.png', 'hollow_frame.png']) {
    const index = names.findIndex((name) => name.includes(target));
    if (index >= 0) await page.locator('.frame-row').nth(index).locator('.icon-button').click();
  }
  await page.getByRole('button', { name: '动画', exact: true }).click();
  await page.waitForTimeout(1500);
  const caption = await page.locator('.player-caption').innerText();
  check(caption.includes('帧'), 'animation player reports frames', caption);
  const durations = page.locator('.anim-editor input[type=number]');
  const durationCount = await durations.count();
  for (let i = 0; i < durationCount; i++) {
    await durations.nth(i).fill('700');
    await durations.nth(i).dispatchEvent('change');
  }
  await page.getByRole('button', { name: '重播' }).click();
  const states = new Set();
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(220);
    states.add(
      await page.evaluate(() => {
        const canvas = document.querySelector('.player-stage canvas');
        if (!canvas) return 'none';
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = 0;
        let sum = 0;
        for (let p = 3; p < data.length; p += 4) {
          if (data[p] > 0) {
            opaque++;
            sum += data[p - 3] + data[p - 2] + data[p - 1];
          }
        }
        return `${canvas.width}x${canvas.height}:${opaque}:${sum}`;
      }),
    );
  }
  check(states.size >= 4, 'animation actually cycles through frames', `${states.size} distinct states`);

  console.log('\n== export + standalone preview ==');
  await page.getByRole('button', { name: '导出与独立预览' }).click();
  await page.getByRole('button', { name: /导出全部页面/ }).click();
  await page.waitForTimeout(3000);
  const exportHead = await page.locator('.verification-head').last().innerText();
  check(exportHead.includes('自动验证通过'), 'export verification passes', exportHead.split('\n')[1] ?? '');

  const zipHref = await page.locator('a', { hasText: '下载 ZIP' }).getAttribute('href');
  const response = await page.request.get(new URL(zipHref, baseUrl).toString());
  const zipPath = '/tmp/sprite-atlas-e2e.zip';
  await fsp.writeFile(zipPath, await response.body());
  const zipBuffer = await fsp.readFile(zipPath);
  check(zipBuffer.length > 0, 'ZIP downloaded', `${zipBuffer.length} bytes`);

  await page.locator('input[type=file][accept=".zip,application/zip"]').setInputFiles(zipPath);
  await page.waitForTimeout(2500);
  const standaloneHead = await page.locator('.standalone .verification-head').innerText();
  check(standaloneHead.includes('自动验证通过'), 'standalone ZIP verification passes');
  const standaloneCaption = await page.locator('.standalone .player-caption').innerText();
  const captionTail = (text) =>
    text
      .replace(/\s+/g, ' ')
      .split(' · ')
      .filter((part) => part.startsWith('锚点') || part.startsWith('统一原始画布'))
      .join(' · ');
  check(
    captionTail(standaloneCaption) === captionTail(caption),
    'standalone player uses the same anchor and stage as the live animation',
    standaloneCaption,
  );

  // Unpacked files, as a second entry path.
  const unzipDir = '/tmp/sprite-atlas-e2e-unzipped';
  await fsp.rm(unzipDir, { recursive: true, force: true });
  await fsp.mkdir(unzipDir, { recursive: true });
  execFileSync('unzip', ['-qo', zipPath, '-d', unzipDir]);
  const pageFiles = await fsp.readdir(`${unzipDir}/pages`);
  await page.locator('input[type=file][accept=".json,.png,application/json,image/png"]').setInputFiles([
    `${unzipDir}/atlas.json`,
    `${unzipDir}/animation.json`,
    ...pageFiles.map((file) => `${unzipDir}/pages/${file}`),
  ]);
  await page.waitForTimeout(2500);
  check(
    (await page.locator('.standalone .mono.muted').first().innerText()).includes('散装文件'),
    'loose exported files load too',
  );

  check(consoleErrors.length === 0, 'no browser console errors', consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log('');
if (failures.length > 0) {
  console.log(`RESULT: FAILED (${failures.length})`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('RESULT: OK — browser flow passed');
