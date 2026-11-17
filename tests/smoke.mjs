/**
 * tests/smoke.mjs —— 浏览器端冒烟测试(Playwright)
 *
 * 运行:npx playwright install chromium && node tests/smoke.mjs
 * 检查:页面无控制台错误、WebGL 与展开图渲染、页面内 V1–V9 全通过、
 * 错误注入后检查点标记误转、边点击配对、姿态切换、截图人工复核。
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5199;
const BASE = `http://localhost:${PORT}`;

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server 启动超时')), 30000);
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) { clearTimeout(t); resolve(); }
  });
  server.stderr.on('data', (d) => process.stdout.write(d));
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await wait(1200);

  check('WebGL 画布存在', await page.locator('#viewport canvas').count() >= 1);
  check('展开图画布存在', await page.locator('#unfold').count() === 1);
  check('初始无控制台错误', errors.length === 0, errors.join(' | '));

  // 初始检查点读数
  const cp0 = await page.locator('.cp-card').count();
  check('初始检查点读数卡片', cp0 >= 1, `${cp0} 张`);
  const readoutText = await page.locator('#readouts').innerText();
  check('读数含命中环境面与网格', readoutText.includes('命中环境面') && readoutText.includes('编号'));

  // 页面内验证
  await page.click('#btn-validate');
  await wait(300);
  const passN = await page.locator('.v-case.pass').count();
  const failN = await page.locator('.v-case.fail').count();
  check('页面内 V1–V9 全部通过', passN === 9 && failN === 0, `${passN} pass / ${failN} fail`);

  // 错误注入:把 +X 面旋转 90°
  await page.selectOption('#err-face', 'px');
  await page.selectOption('#err-rot', '1');
  await page.click('#btn-apply-err');
  await wait(400);
  const errStatus = await page.locator('#err-status').innerText();
  check('错误状态面板提示误转', errStatus.includes('+X') && errStatus.includes('90'));
  // 展开图中 +X 槽位出现红色警告描边
  const tileWarnings = await page.evaluate(() =>
    Array.from(document.querySelectorAll('canvas')).length);
  check('展开图仍正常重绘', tileWarnings >= 2);
  // 切换到一个反射命中 +X 的姿态,检查点必须标记误转
  await page.selectOption('#err-face', 'pz');
  await page.selectOption('#err-rot', '0');
  await page.click('#btn-apply-err'); // 先清掉 +X 错误
  await page.selectOption('#err-face', 'nx');
  await page.selectOption('#err-rot', '2');
  await page.click('#btn-apply-err'); // 初始检查点反射命中 -X,给 -X 注入 180°
  await wait(400);
  const readoutAfter = await page.locator('#readouts').innerText();
  check('命中误转面时检查点给出警告', readoutAfter.includes('误转') || readoutAfter.includes('pill bad'));

  // 一键恢复
  await page.click('#btn-reset-err');
  await wait(300);
  const errStatus2 = await page.locator('#err-status').innerText();
  check('一键恢复全部面', errStatus2.includes('规范朝向'));

  // 点击展开图的一条边(+Z 面右边中心),验证配对信息
  const unfold = page.locator('#unfold');
  await unfold.scrollIntoViewIfNeeded();
  await wait(200);
  // 内部坐标:+Z 槽位(col=1,row=1)右边中心 = (PAD+2*TILE, PAD+1.5*TILE) = (526,406)
  const edgeClicked = await page.evaluate(() => {
    const c = document.getElementById('unfold');
    const b = c.getBoundingClientRect();
    const [ix, iy] = [46 + 2 * 240, 46 + 1.5 * 240];
    const el = document.elementFromPoint(
      b.x + ix * (b.width / c.width),
      b.y + iy * (b.height / c.height),
    );
    return el === c;
  });
  check('点击目标落在展开图画布上', edgeClicked);
  await page.evaluate(() => {
    const c = document.getElementById('unfold');
    const b = c.getBoundingClientRect();
    const [ix, iy] = [46 + 2 * 240, 46 + 1.5 * 240];
    c.dispatchEvent(new MouseEvent('click', {
      clientX: b.x + ix * (b.width / c.width),
      clientY: b.y + iy * (b.height / c.height),
      bubbles: true,
    }));
  });
  await wait(200);
  const edgeInfo = await page.locator('#edge-info').innerText();
  check('边点击显示共享边配对', edgeInfo.includes('共享边') && edgeInfo.includes('刻度'));
  check('边信息含逐刻度对应表', await page.locator('#edge-info table tr').count() >= 9);

  // 姿态切换:六个主轴 + 跨面 + 旋转对照
  for (const pid of ['view-px', 'view-py', 'view-nz', 'seam', 'rotate-a', 'rotate-b']) {
    await page.click(`[data-pose="${pid}"]`);
    await wait(350);
  }
  check('姿态切换无控制台错误', errors.length === 0, errors.join(' | '));
  const seamReadout = await page.locator('#readouts').innerText();
  check('旋转对照姿态仍有读数', seamReadout.includes('反射方向'));

  // 物体旋转滑块
  await page.fill('#rot-y', '45');
  await page.dispatchEvent('#rot-y', 'input');
  await wait(300);
  const rotReadout = await page.locator('#readouts').innerText();
  check('旋转物体后读数刷新', rotReadout.includes('反射方向'));
  await page.click('#btn-reset-object');

  // 镜面球拾取:先用页面内射线定位球面屏幕位置,再真实点击走完整事件路径
  const spherePt = await page.evaluate(() => {
    const v = window.__viewer;
    for (let fx = 0.1; fx <= 0.6; fx += 0.05) {
      for (let fy = 0.3; fy <= 0.7; fy += 0.1) {
        if (v.debugRaycast(fx, fy).some((s) => s.startsWith('mirror@'))) return { fx, fy };
      }
    }
    return null;
  });
  check('射线能定位镜面球', !!spherePt);
  if (spherePt) {
    const vpBox = await page.locator('#viewport canvas').boundingBox();
    await page.mouse.click(
      vpBox.x + vpBox.width * spherePt.fx,
      vpBox.y + vpBox.height * spherePt.fy,
    );
    await wait(300);
    const mirrorCard = await page.locator('.cp-card').last().innerText();
    check('镜面球检查点含球面法线与命中面',
      mirrorCard.includes('镜面球') && mirrorCard.includes('表面朝向') && mirrorCard.includes('命中环境面'));
    const activeObj = await page.locator('#object-select .btn.active').innerText();
    check('拾取后自动选中镜面球', activeObj.includes('镜面球'));
  }

  await page.screenshot({ path: 'tests/shot-overview.png', fullPage: true });

  // 放大 3D 视图单独截图
  await page.click('#btn-reset-object');
  await page.click('[data-pose="default"]');
  await wait(400);
  const vp = await page.locator('#viewport').boundingBox();
  await page.screenshot({ path: 'tests/shot-viewport.png', clip: vp });

  check('全程无控制台错误', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n浏览器冒烟:${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
