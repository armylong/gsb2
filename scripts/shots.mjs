#!/usr/bin/env node
/**
 * Screenshot helper for manual visual review.
 *   1. npm run dev            (http://127.0.0.1:5173)
 *   2. node scripts/shots.mjs all|scenarios|hover|debug|edit|zoomed
 * Writes PNGs into /tmp/shots.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const target = process.argv[2] ?? 'all';
const url = process.env.SANDBOX_URL ?? 'http://127.0.0.1:5173/';
mkdirSync('/tmp/shots', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.__stage));
await page.waitForTimeout(400);
const box = await (await page.$('#map')).boundingBox();

async function screenOf(col, row) {
  const point = await page.evaluate(
    ([col, row]) => {
      const { camera, centreOf } = window.__stage;
      const c = centreOf(col, row);
      return {
        x: (c.x - camera.centre.x) * camera.zoom + camera.viewport.width / 2,
        y: (c.y - camera.centre.y) * camera.zoom + camera.viewport.height / 2,
      };
    },
    [col, row],
  );
  return { x: box.x + point.x, y: box.y + point.y };
}

const want = (name) => target === 'all' || target === name;

if (want('scenarios')) {
  for (const id of ['sandbox', 'corner', 'door', 'handoff']) {
    await page.evaluate((id) => window.__stage.loadScenario(id), id);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `/tmp/shots/${id}.png` });
  }
}

if (want('hover')) {
  await page.evaluate(() => window.__stage.loadScenario('sandbox'));
  await page.waitForTimeout(250);
  for (const [name, col, row] of [['hover-visible', 5, 6], ['hover-hidden', 9, 5]]) {
    const pos = await screenOf(col, row);
    await page.mouse.move(pos.x, pos.y);
    await page.waitForTimeout(220);
    await page.screenshot({ path: `/tmp/shots/${name}.png` });
  }
}

if (want('debug')) {
  await page.evaluate(() => {
    window.__stage.loadScenario('corner');
    window.__stage.setMode('debug');
  });
  await page.waitForTimeout(250);
  const pos = await screenOf(9, 6);
  await page.mouse.move(pos.x, pos.y);
  await page.waitForTimeout(280);
  await page.screenshot({ path: '/tmp/shots/debug-blocked.png' });
}

if (want('edit')) {
  await page.evaluate(() => {
    window.__stage.loadScenario('door');
    window.__stage.setMode('edit');
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/shots/edit.png' });
  await page.evaluate(() => window.__stage.toggleDoorAt(7, 5));
  await page.waitForTimeout(280);
  await page.screenshot({ path: '/tmp/shots/door-open.png' });
}

if (want('zoomed')) {
  await page.evaluate(() => {
    window.__stage.loadScenario('handoff');
    window.__stage.setMode('player');
  });
  await page.waitForTimeout(220);
  const pos = await screenOf(5, 3);
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(pos.x, pos.y);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(45);
  }
  await page.waitForTimeout(280);
  await page.screenshot({ path: '/tmp/shots/zoomed.png' });
}

if (errors.length) console.error(errors.join('\n'));
else console.log('screenshots written to /tmp/shots');
await browser.close();
