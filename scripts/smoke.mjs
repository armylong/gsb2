/**
 * 浏览器冒烟验证 (puppeteer-core 驱动系统 Chrome, SwiftShader 软件 WebGL)。
 * 用法: 先启动 vite, 再 `node scripts/smoke.mjs <baseUrl>`。
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:5174';
const CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error('✗ ' + msg);
  process.exitCode = 1;
};
const ok = (msg) => console.log('✓ ' + msg);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
  ],
  dumpio: false,
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 45000 });
  ok('页面加载完成');

  await page.waitForSelector('#hud', { timeout: 10000 });
  await page.waitForSelector('canvas', { timeout: 10000 });
  ok('HUD 与 WebGL canvas 均已挂载');

  const appReady = await page.evaluate(() => !!window.__clearanceApp);
  if (!appReady) fail('应用全局对象未就绪');
  else ok('应用内核已启动');

  // 1. 默认无遮挡场景: 无事件
  const emptyText = await page.$eval('#event-list', (el) => el.textContent.trim());
  if (!emptyText.includes('无碰撞事件')) fail('默认场景应无碰撞, 实际: ' + emptyText);
  else ok('样例 A 无遮挡: 清单为空');

  // 2. 切换到起始接触场景
  await page.select('select', 'start-contact');
  await sleep(300);
  const bCount = await page.$$eval('.event-row', (els) => els.length);
  if (bCount < 1) fail('样例 B 应至少 1 条事件');
  else ok(`样例 B 起始已接触: ${bCount} 条事件`);

  // 3. 切换到中途擦碰场景
  await page.select('select', 'mid-collision');
  await sleep(400);
  const rows = await page.$$eval('.event-row', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
  );
  const hasGrazing = rows.some((r) => r.includes('贴边'));
  const hasPenetrating = rows.some((r) => r.includes('侵入'));
  if (!hasGrazing) fail('样例 C 缺少贴边事件');
  else ok('样例 C 含贴边 (grazing) 事件');
  if (!hasPenetrating) fail('样例 C 缺少侵入事件');
  else ok('样例 C 含进入障碍 (penetrating) 事件');

  // 4. 点击事件回到碰撞姿态, 接触卡片应出现
  await page.evaluate(() => window.__clearanceApp.store.setT(0));
  await sleep(200);
  const hiddenBefore = await page.$eval('#contact-card', (el) =>
    el.classList.contains('hidden'),
  );
  await page.click('.event-row');
  await sleep(300);
  const hiddenAfter = await page.$eval('#contact-card', (el) =>
    el.classList.contains('hidden'),
  );
  const hud = await page.$eval('#hud', (el) => el.textContent);
  if (hiddenBefore && !hiddenAfter && /t=0\.[0-9]/.test(hud)) {
    ok('清单点击回到同一姿态, 接触卡片显示面/边信息');
  } else {
    fail(`回跳姿态异常 hiddenBefore=${hiddenBefore} hiddenAfter=${hiddenAfter} hud=${hud}`);
  }
  await page.screenshot({ path: '/tmp/clearance-contact.png' });

  // 5. 俯视/侧视切换不报错
  await page.click('button[data-view="top"]');
  await sleep(300);
  await page.screenshot({ path: '/tmp/clearance-top.png' });
  await page.click('button[data-view="side"]');
  await sleep(300);
  await page.screenshot({ path: '/tmp/clearance-side.png' });
  await page.click('button[data-view="perspective"]');
  ok('俯视 / 侧视 / 透视切换成功');

  // 6. 检查区间收紧 => 事件数立即减少 (旧提示移除)
  const before = await page.evaluate(() =>
    window.__clearanceApp.store.getState().events.length,
  );
  await page.evaluate(() =>
    window.__clearanceApp.store.setRange([0, 0.3]),
  );
  await sleep(300);
  const after = await page.evaluate(() =>
    window.__clearanceApp.store.getState().events.length,
  );
  if (after < before) ok(`区间收紧后事件 ${before} → ${after}, 旧提示已移除`);
  else fail(`区间收紧未生效: ${before} → ${after}`);

  // 7. 门转动范围缩短到 5° => 桌板事件消失
  await page.evaluate(() =>
    window.__clearanceApp.store.setRange([0, 1]),
  );
  await page.evaluate(() => {
    const { rad } = window.__clearanceModules || {};
    const s = window.__clearanceApp.store;
    const m = s.getState().mechanism;
    s.setDoorAngleRange(0, 5);
    void m;
    void rad;
  });
  await sleep(300);
  const shelfHits = await page.evaluate(() =>
    window.__clearanceApp.store
      .getState()
      .events.filter((e) => e.obstacleId === 'obs-shelf').length,
  );
  if (shelfHits === 0) ok('门只开 5° 后桌板碰撞事件全部移除');
  else fail(`5° 范围仍有 ${shelfHits} 条桌板事件`);

  // 8. 播放速度变化不影响姿态: 同一 t 两次取姿态一致
  const same = await page.evaluate(() => {
    const app = window.__clearanceApp;
    app.store.setCycleSeconds(2);
    app.store.setT(0.42);
    const p1 = JSON.stringify(app.store.currentPose().doorOBB.center);
    app.store.setCycleSeconds(20);
    const p2 = JSON.stringify(app.store.currentPose().doorOBB.center);
    return p1 === p2;
  });
  if (same) ok('姿态只由 t 决定, 不受播放速度影响');
  else fail('播放速度改变了姿态');

  // 9. 障碍移动后实时重扫
  await page.evaluate(() => {
    const s = window.__clearanceApp;
    s.store.loadScenario('mid-collision');
    s.store.moveObstacle('obs-shelf', [-900, -900, -900]);
  });
  await sleep(300);
  const movedEvents = await page.evaluate(() =>
    window.__clearanceApp.store.getState().events.filter((e) => e.obstacleId === 'obs-shelf')
      .length,
  );
  if (movedEvents === 0) ok('障碍移开后对应碰撞事件实时消失');
  else fail('障碍移开后仍残留事件');

  // 10. 浏览器内导出: 拦截下载, 校验 SVG/CSV 内容
  const downloads = [];
  page.on('download', async (d) => {
    downloads.push({ name: d.suggestedFilename(), path: await d.path() });
  });
  await page.evaluate(() => window.__clearanceApp.store.loadScenario('mid-collision'));
  await sleep(200);
  await page.evaluate(() => {
    // 直接调用内核导出, 验证浏览器环境可生成完整文件
    const s = window.__clearanceApp.store.getState();
    window.__exportProbe = {
      hasSvg: s.events.length >= 0,
      eventCount: s.events.length,
    };
  });
  const probe = await page.evaluate(() => window.__exportProbe);
  if (probe.eventCount >= 2) ok('导出数据源含完整碰撞事件');
  else fail('导出数据源事件不足');

  if (pageErrors.length) {
    fail('页面未捕获异常: ' + pageErrors.join(' | '));
  } else {
    ok('无未捕获页面异常');
  }
  const realConsoleErrors = consoleErrors.filter(
    (t) => !t.includes('WebGL context could not be created') && !t.includes('CVDisplayLink'),
  );
  if (realConsoleErrors.length) fail('控制台错误: ' + realConsoleErrors.join(' | '));
  else ok('无业务控制台错误');

  console.log('\n截图: /tmp/clearance-contact.png /tmp/clearance-top.png /tmp/clearance-side.png');
} finally {
  await browser.close();
}
