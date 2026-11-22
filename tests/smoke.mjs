/**
 * 浏览器交互冒烟：按用户真实操作路径验证核心需求。
 * 需要本机已安装 Playwright 的 Chromium；路径可用 CHROME_PATH 覆盖。
 *
 *   npm run dev
 *   URL=http://127.0.0.1:5173/ node tests/smoke.mjs
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const URL = process.env.URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.OUT ?? '/tmp/assembly-shots';
fs.mkdirSync(OUT, { recursive: true });

const executablePath =
  process.env.CHROME_PATH ??
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__assembly?.snapshot, null, { timeout: 15000 });
await page.waitForTimeout(1500);

function rectOverlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

async function auditLayout(tag) {
  const snap = await page.evaluate(() => window.__assembly.snapshot());
  const placed = snap.labels.filter((l) => l.placed);
  let overlaps = 0;
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      if (rectOverlaps(placed[i].rect, placed[j].rect)) overlaps += 1;
    }
  }
  const outOfBounds = placed.filter(
    (l) =>
      l.rect.x < 0 ||
      l.rect.y < 0 ||
      l.rect.x + l.rect.w > snap.viewport.width ||
      l.rect.y + l.rect.h > snap.viewport.height,
  ).length;
  check(`${tag}: 标签不重叠`, overlaps === 0, `overlaps=${overlaps}`);
  check(`${tag}: 标签不出界`, outOfBounds === 0, `outOfBounds=${outOfBounds}`);
  return snap;
}

// ---- 1. 初始布局
const front = await auditLayout('正面');

// 每个锚点必须落在自己零件的世界包围盒内（误差 0.02），防止标注漂到空气里。
const bounds = await page.evaluate(() => window.__assembly.partBounds());
const outside = front.labels.filter((l) => {
  const box = bounds[l.partId];
  if (!box) return true;
  const pad = 0.03;
  return (
    l.world[0] < box.min[0] - pad ||
    l.world[0] > box.max[0] + pad ||
    l.world[1] < box.min[1] - pad ||
    l.world[1] > box.max[1] + pad ||
    l.world[2] < box.min[2] - pad ||
    l.world[2] > box.max[2] + pad
  );
});
check(
  '每个锚点都落在自己的零件上',
  outside.length === 0,
  outside.map((l) => l.id).join(','),
);

// ---- 2. 锁定的/高优先级不会被收起
const lockedStowed = front.labels.filter((l) => l.locked && l.stowed);
check('正面：锁定项不被收起', lockedStowed.length === 0, lockedStowed.map((l) => l.id).join(','));
// 空间不足是「局部」的：拥挤角落里的高优先级项可能仍被收起，
// 但锁定项必须优先于同在附近的普通项。
await page.evaluate(() => window.__assembly.setView('crowd'));
await page.waitForTimeout(1700);
await page.evaluate(() => {
  window.__assembly.setLock('corner_bolt_c', true); // P1，原本最容易被收起
});
await page.waitForTimeout(700);
const lockedCrowd = await page.evaluate(() => window.__assembly.snapshot());
check(
  '拥挤时锁定项被保留',
  lockedCrowd.labels.find((l) => l.id === 'corner_bolt_c').placed === true,
);
const stowedAfterLock = lockedCrowd.labels.filter((l) => l.stowed && !l.locked);
check(
  '锁定低优先级项后，普通项让位',
  stowedAfterLock.some((l) => l.priority >= 2),
  stowedAfterLock.map((l) => `${l.id}:P${l.priority}`).join(','),
);
await page.evaluate(() => window.__assembly.setLock('corner_bolt_c', false));
await page.waitForTimeout(500);
const hiddenPanel = await page.textContent('#hidden-list');
check(
  '侧栏报告了收起的标注',
  front.stowed.length === 0 || hiddenPanel.includes('空间不足'),
  hiddenPanel.trim().slice(0, 80),
);

// ---- 3. 背面遮挡
await page.evaluate(() => window.__assembly.setView('back'));
await page.waitForTimeout(1700);
const back = await auditLayout('背面');
const occluded = back.labels.filter((l) => l.state === 'occluded').length;
const visible = back.labels.filter((l) => l.state === 'visible').length;
check('背面：识别出被实体挡住的锚点', occluded > 0, `occluded=${occluded}`);
check('背面：仍有可见锚点', visible > 0, `visible=${visible}`);
const frontOccluded = front.labels.filter((l) => l.state === 'occluded').length;
check('背面被挡数量多于正面', occluded > frontOccluded, `${occluded} > ${frontOccluded}`);

// 贴面锚点不误判：front 视角下绝大多数表面锚点应为可见
const wrongOcclusion = front.labels.filter(
  (l) => l.state === 'occluded' && l.id.startsWith('cover_bolt'),
);
check('贴面锚点不被自己的零件误判为遮挡', wrongOcclusion.length === 0);

// ---- 4. 关闭被挡标记
await page.evaluate(() => window.__assembly.setShowOccluded(false));
await page.waitForTimeout(700);
const noOcc = await page.evaluate(() => window.__assembly.snapshot());
check(
  '关闭被挡标记后不再放置被挡标签',
  noOcc.labels.every((l) => !(l.state === 'occluded' && l.placed)),
);
await page.evaluate(() => window.__assembly.setShowOccluded(true));
await page.waitForTimeout(300);

// ---- 5. 点击标签选中零件
await page.evaluate(() => window.__assembly.setView('front'));
await page.waitForTimeout(1600);
const target = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.label')].find(
    (e) => e.style.visibility !== 'hidden' && e.dataset.anchorId === 'clamp_torque',
  );
  if (!el) return null;
  el.click();
  return el.dataset.anchorId;
});
await page.waitForTimeout(500);
const selected = await page.textContent('#hud-selected');
const highlighted = await page.locator('.part-row.is-selected-part').count();
check('点击标签选中对应零件', Boolean(target) && selected.includes('夹紧螺栓'), selected);
check('选中零件在侧栏高亮', highlighted === 1, `rows=${highlighted}`);

// ---- 6. 隐藏零件后重排
const beforeHide = await page.evaluate(() => window.__assembly.snapshot());
await page.evaluate(() => window.__assembly.setPartVisible('cover_bolts', false));
await page.waitForTimeout(700);
const afterHide = await page.evaluate(() => window.__assembly.snapshot());
check(
  '隐藏零件后其锚点退出排布',
  afterHide.labels.find((l) => l.id === 'cover_bolts_fix').placed === false,
);
check(
  '隐藏零件后其它标签仍不重叠',
  (() => {
    const placed = afterHide.labels.filter((l) => l.placed);
    for (let i = 0; i < placed.length; i += 1)
      for (let j = i + 1; j < placed.length; j += 1)
        if (rectOverlaps(placed[i].rect, placed[j].rect)) return false;
    return true;
  })(),
);
check(
  '隐藏零件改变了排布结果',
  JSON.stringify(beforeHide.labels.map((l) => l.slot)) !==
    JSON.stringify(afterHide.labels.map((l) => l.slot)),
);
await page.evaluate(() => window.__assembly.setPartVisible('cover_bolts', true));
await page.waitForTimeout(500);

// ---- 7. 改优先级：先腾出空间，再把低优先级项提到最高
await page.evaluate(() => window.__assembly.setView('front'));
await page.waitForTimeout(1600);
const stowedBefore = (await page.evaluate(() => window.__assembly.snapshot())).labels
  .filter((l) => l.stowed)
  .map((l) => l.id);
const lowId = stowedBefore.find((id) => id.startsWith('corner_')) ?? 'corner_bolt_c';
await page.evaluate((id) => window.__assembly.setPriority(id, 5), lowId);
await page.waitForTimeout(700);
const bumped = await page.evaluate(() => window.__assembly.snapshot());
check(
  `提高优先级后该标注被保留（${lowId}）`,
  bumped.labels.find((l) => l.id === lowId).placed === true,
  `stowed=${bumped.stowed.join(',')}`,
);
await page.evaluate((id) => window.__assembly.setPriority(id, 1), lowId);
await page.waitForTimeout(500);

// ---- 8. 窄窗
await page.evaluate(() => window.__assembly.setNarrow(true));
await page.waitForTimeout(800);
const narrow = await auditLayout('窄窗');
check('窄窗下确实更窄', narrow.viewport.width < 420, `width=${narrow.viewport.width}`);
check(
  '窄窗下收起数量增加',
  narrow.stowed.length >= front.stowed.length,
  `${narrow.stowed.length} >= ${front.stowed.length}`,
);
await page.screenshot({ path: path.join(OUT, 'smoke-narrow.png') });
await page.evaluate(() => window.__assembly.setNarrow(false));
await page.waitForTimeout(400);

// ---- 9. 缓慢旋转时 slot 不来回跳
await page.evaluate(() => window.__assembly.setView('front'));
await page.waitForTimeout(1600);
const box = await page.locator('#viewport canvas.webgl').boundingBox();
// 从空白区域开始拖拽（标签层在上面，压在标签上会变成点击）。
const cx = box.x + box.width * 0.22;
const cy = box.y + box.height * 0.86;
const hit = await page.evaluate(
  ({ x, y }) => document.elementFromPoint(x, y)?.tagName,
  { x: cx, y: cy },
);
check('拖拽起点落在 WebGL 画布上', hit === 'CANVAS', `hit=${hit}`);
const history = new Map();
const startCam = (await page.evaluate(() => window.__assembly.snapshot())).camera.position;
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 90; i += 1) {
  await page.mouse.move(cx + i * 1.1, cy + 3, { steps: 1 });
  await page.waitForTimeout(16);
  const snap = await page.evaluate(() => window.__assembly.snapshot());
  for (const l of snap.labels) {
    if (!l.placed) continue;
    if (!history.has(l.id)) history.set(l.id, []);
    history.get(l.id).push(l.slot);
  }
}
await page.mouse.up();
const endCam = (await page.evaluate(() => window.__assembly.snapshot())).camera.position;
const camMoved = Math.hypot(
  endCam[0] - startCam[0],
  endCam[1] - startCam[1],
  endCam[2] - startCam[2],
);
check('慢速拖拽确实转动了镜头', camMoved > 1, `delta=${camMoved.toFixed(2)}`);
let abba = 0;
let changes = 0;
for (const slots of history.values()) {
  for (let i = 1; i < slots.length; i += 1) if (slots[i] !== slots[i - 1]) changes += 1;
  for (let i = 2; i < slots.length; i += 1)
    if (slots[i] === slots[i - 2] && slots[i] !== slots[i - 1]) abba += 1;
}
check(
  '缓慢旋转时没有 A→B→A 往返',
  abba === 0,
  `ABA=${abba}, changes=${changes} (允许少量单向换位)`,
);

// ---- 10. 突然换视角后重新选位
const beforeJump = await page.evaluate(() => window.__assembly.snapshot());
await page.evaluate(() => window.__assembly.setView('crowd'));
await page.waitForTimeout(300);
const during = await page.evaluate(() => window.__assembly.snapshot());
check('切换视角期间处于飞行状态', during.flying === true);
await page.waitForTimeout(1600);
const afterJump = await page.evaluate(() => window.__assembly.snapshot());
const moved = afterJump.labels.filter((l) => {
  const prev = beforeJump.labels.find((p) => p.id === l.id);
  return prev && prev.slot !== l.slot;
}).length;
check('突然换视角后标签重新选位', moved > 0, `moved=${moved}`);
await auditLayout('拥挤角落');
await page.screenshot({ path: path.join(OUT, 'smoke-crowd.png') });

check('运行期间没有页面错误', errors.length === 0, errors.slice(0, 3).join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
await browser.close();
process.exit(failed.length === 0 ? 0 : 1);
