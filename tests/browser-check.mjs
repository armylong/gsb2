import { chromium } from 'playwright-core';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const URL = process.env.URL ?? 'http://127.0.0.1:5199/';
const OUT = process.env.OUT ?? '/tmp/assembly-shots';
fs.mkdirSync(OUT, { recursive: true });

const executablePath = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
);

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__assembly?.snapshot, null, { timeout: 15000 });
await page.waitForTimeout(1500);

async function shot(name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function snapshot() {
  return page.evaluate(() => window.__assembly.snapshot());
}

const report = {};
report.initial = await snapshot();
await shot('01-front');

// 背面
await page.evaluate(() => window.__assembly.setView('back'));
await page.waitForTimeout(1600);
report.back = await snapshot();
await shot('02-back');

// 侧面
await page.evaluate(() => window.__assembly.setView('side'));
await page.waitForTimeout(1600);
report.side = await snapshot();

// 拥挤角落
await page.evaluate(() => window.__assembly.setView('crowd'));
await page.waitForTimeout(1600);
report.crowd = await snapshot();
await shot('03-crowd');

// 窄窗
await page.setViewportSize({ width: 900, height: 700 });
await page.evaluate(() => window.__assembly.setNarrow(true));
await page.waitForTimeout(900);
report.narrow = await snapshot();
await shot('04-narrow');

await page.setViewportSize({ width: 1440, height: 900 });
await page.evaluate(() => window.__assembly.setNarrow(false));
await page.evaluate(() => window.__assembly.setView('front'));
await page.waitForTimeout(1600);

// 慢速旋转稳定性：用按钮视角无法细粒度转动，这里通过直接拖动 canvas 模拟
const box = await page.locator('#viewport canvas.webgl').boundingBox();
const cx = box.x + box.width * 0.55;
const cy = box.y + box.height * 0.55;
const slotsPerFrame = [];
await page.mouse.move(cx, cy);
await page.mouse.down();
const steps = 90;
for (let i = 1; i <= steps; i += 1) {
  await page.mouse.move(cx + i * 0.9, cy + 4, { steps: 1 });
  await page.waitForTimeout(16);
  const snap = await page.evaluate(() => window.__assembly.snapshot());
  slotsPerFrame.push(
    snap.labels
      .filter((l) => l.placed)
      .map((l) => `${l.id}:${l.slot}:${l.direction}`),
  );
}
await page.mouse.up();
await page.waitForTimeout(400);
report.rotateSlots = slotsPerFrame;
await shot('05-after-rotate');

// 点击标签 → 选中零件
await page.evaluate(() => window.__assembly.setView('front'));
await page.waitForTimeout(1500);
const labelClick = await page.evaluate(() => {
  const el = document.querySelector('.label:not([style*="hidden"])');
  if (!el) return null;
  const id = el.dataset.anchorId;
  el.click();
  return id;
});
await page.waitForTimeout(500);
report.labelClick = {
  id: labelClick,
  selectedText: await page.textContent('#hud-selected'),
  highlighted: await page.evaluate(
    () => document.querySelectorAll('.part-row.is-selected-part').length,
  ),
};
await shot('06-label-selected');

// 隐藏零件
await page.evaluate(() => window.__assembly.setPartVisible('housing', false));
await page.waitForTimeout(700);
report.afterHide = await snapshot();
await shot('07-hide-part');
await page.evaluate(() => window.__assembly.setPartVisible('housing', true));
await page.waitForTimeout(500);

// 优先级 / 锁定
await page.evaluate(() => {
  window.__assembly.setPriority('corner_bolt_c', 5);
  window.__assembly.setLock('corner_bolt_b', true);
});
await page.waitForTimeout(600);
report.afterPriority = await snapshot();

// 关闭被挡显示
await page.evaluate(() => window.__assembly.setShowOccluded(false));
await page.waitForTimeout(600);
report.noOccluded = await snapshot();
await page.evaluate(() => window.__assembly.setShowOccluded(true));

// 摆臂摆动，验证锚点跟随（world 坐标必须变化，屏幕坐标随之变化）
await page.evaluate(() => window.__assembly.setView('front'));
await page.waitForTimeout(1500);
const arm0 = await page.evaluate(() => {
  window.__assembly.setArmAngle(0);
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const l = window.__assembly.snapshot().labels.find((x) => x.id === 'clamp_torque');
        resolve({ world: l.world, screen: l.screen });
      }),
    ),
  );
});
const arm30 = await page.evaluate(() => {
  window.__assembly.setArmAngle(30);
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const l = window.__assembly.snapshot().labels.find((x) => x.id === 'clamp_torque');
        resolve({ world: l.world, screen: l.screen });
      }),
    ),
  );
});
report.arm = { arm0, arm30 };
await page.waitForTimeout(500);
await shot('08-arm');

// 检查标签重叠 / 出界
function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
report.overlapCheck = {};
for (const key of ['initial', 'back', 'crowd', 'narrow', 'afterHide', 'afterPriority']) {
  const snap = report[key];
  const placed = snap.labels.filter((l) => l.placed);
  let overlapsCount = 0;
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      if (overlaps(placed[i].rect, placed[j].rect)) overlapsCount += 1;
    }
  }
  const out = placed.filter(
    (l) =>
      l.rect.x < 0 ||
      l.rect.y < 0 ||
      l.rect.x + l.rect.w > snap.viewport.width ||
      l.rect.y + l.rect.h > snap.viewport.height,
  ).length;
  report.overlapCheck[key] = {
    placed: placed.length,
    stowed: snap.stowed.length,
    overlaps: overlapsCount,
    outOfBounds: out,
    occludedPlaced: placed.filter((l) => l.state === 'occluded').length,
  };
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ errors, overlapCheck: report.overlapCheck, labelClick: report.labelClick, arm: report.arm }, null, 2));
await browser.close();
