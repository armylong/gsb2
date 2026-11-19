// 无头浏览器冒烟测试：验证页面加载、WebGL 双视口、模式切换、角度调整、
// 问题清单渲染、损坏文件拦截与导出回读流程。
// 运行：node scripts/browser-smoke.mjs （需要 python 服务已在 8123 端口）

import { createRequire } from 'node:module';
// 兼容 npx 缓存中的 playwright（项目本身零运行时依赖）
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const { execSync } = await import('node:child_process');
  const cache = execSync('find ~/.npm/_npx -name "playwright" -maxdepth 4 -type d 2>/dev/null | head -1')
    .toString().trim();
  const mod = await import(new URL('file://' + cache + '/index.js').href);
  chromium = mod.chromium ?? mod.default.chromium;
}

const BASE = process.env.BASE_URL || 'http://localhost:8123/index.html';
const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✓' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#sampleGroups .sample-btn');

// 1. 加载规则立方体
await page.getByRole('button', { name: '规则立方体' }).click();
await page.waitForFunction(() => document.getElementById('statFaces').textContent.includes('12'));
check('加载立方体，面数显示 12',
  (await page.textContent('#statFaces')).includes('12'));
check('结构信息显示顶点/面/分量',
  (await page.textContent('#metaStruct')).includes('连通分量'));
check('规则立方体问题清单无错误级问题',
  !(await page.textContent('#issueList')).includes('class="badge error"')
  && (await page.textContent('#issueList')).includes('检查通过'));

// 2. 平面/平滑切换
await page.click('.seg-btn[data-mode="flat"]');
await page.waitForTimeout(200);
check('切换到平面模式',
  (await page.textContent('#statMode')).includes('平面'));
await page.click('.seg-btn[data-mode="smooth"]');
await page.waitForTimeout(200);
check('切换回平滑模式',
  (await page.textContent('#statMode')).includes('平滑'));

// 3. 角度边界：0° 与 180°
await page.fill('#angleSlider', '0');
await page.dispatchEvent('#angleSlider', 'input');
await page.waitForTimeout(200);
const label0 = await page.textContent('#vpSmoothLabel');
check('0° 时硬边数为 12', label0.includes('硬边 12 条'), label0);
await page.fill('#angleSlider', '180');
await page.dispatchEvent('#angleSlider', 'input');
await page.waitForTimeout(200);
const label180 = await page.textContent('#vpSmoothLabel');
check('180° 时无硬边', label180.includes('硬边 0 条'), label180);
await page.fill('#angleSlider', '35');
await page.dispatchEvent('#angleSlider', 'input');

// 4. 反向面样例
await page.getByRole('button', { name: '反向面四面体' }).click();
await page.waitForTimeout(300);
const issueText = await page.textContent('#issueList');
check('反向面样例报告 reversed 问题', issueText.includes('反向面'));
check('问题清单可定位到具体面索引', issueText.includes('面索引'));

// 5. 非流形样例
await page.getByRole('button', { name: '非流形边' }).click();
await page.waitForTimeout(300);
check('非流形样例被标记为不可靠区域',
  (await page.textContent('#issueList')).includes('非流形'));

// 6. 全退化模型禁止导出
await page.getByRole('button', { name: '全退化模型（禁止导出）' }).click();
await page.waitForTimeout(300);
const beforeExport = await page.textContent('#loadWarnings');
await page.click('#btnRoundtrip');
await page.waitForTimeout(300);
check('全退化模型导出被阻止并提示',
  (await page.textContent('#toast')).includes('退化') ||
  (await page.textContent('#loadWarnings')).includes('退化'));

// 7. 正常模型导出回读
await page.getByRole('button', { name: '规则立方体' }).click();
await page.waitForTimeout(300);
await page.click('#btnRoundtrip');
await page.waitForTimeout(500);
const rt = await page.textContent('#roundtripTable');
check('回读对比表出现', rt.includes('三角面数'));
const verdict = await page.textContent('#roundtripVerdict');
check('回读验证通过', verdict.includes('一致'));

// 8. 控制台无错误
check('全程无 JavaScript 控制台错误', consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
