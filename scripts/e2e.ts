/**
 * 端到端冒烟检查（playwright-core + 系统 Chrome，无需下载浏览器）。
 * 运行：npx vite-node scripts/e2e.ts
 */
import { chromium } from 'playwright-core';

const URL = 'http://127.0.0.1:5173/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT = '/tmp/tank-shots';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon') && !m.text().includes('404')) {
      errors.push(`console.error: ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(URL);
  await page.waitForSelector('canvas');
  await sleep(1500); // 等自动正视样例

  const panelText = async () => (await page.locator('#panel-right').innerText()).replace(/\s+/g, ' ').slice(0, 260);

  console.log('① 自动正视样例面板:', await panelText());
  await page.screenshot({ path: `${SHOT}-1-front.png` });

  // ② 斜视样例（含侧玻璃 TIR）
  await page.click('#sample-oblique');
  await sleep(400);
  const oblique = await panelText();
  console.log('② 斜视样例面板:', oblique);
  if (!oblique.includes('全反射') && !oblique.includes('刻度读数')) throw new Error('斜视样例缺少预期内容');
  await page.screenshot({ path: `${SHOT}-2-oblique.png` });

  // ③ 拖动水折射率滑条到 1.6，检查实时重追踪不报错
  await page.locator('#ior-water').evaluate((el: any) => {
    el.value = '1.6';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  console.log('③ 改 n_water=1.6 后面板:', await panelText());

  // ④ 水=玻璃=1.45 预设（折射率值显示在滑条标签；面板核对玻璃↔水界面 θI=θT 无偏折）
  await page.click('#preset-equal-wg');
  await sleep(300);
  const wVal = await page.locator('#ior-water-val').innerText();
  const gVal = await page.locator('#ior-glass-val').innerText();
  console.log('④ 水=玻璃预设：n_water=', wVal, ' n_glass=', gVal);
  if (wVal !== '1.450' || gVal !== '1.450') throw new Error('等折射率预设未生效');
  const eqFull = await page.locator('#panel-right').innerText();
  if (!eqFull.includes('不偏折')) throw new Error('等折射率时应提示界面无偏折');

  // ⑤ 全 1 基线预设
  await page.click('#preset-equal-all');
  await sleep(300);
  console.log('⑤ 全1预设面板:', await panelText());
  await page.screenshot({ path: `${SHOT}-5-unity.png` });
  await page.click('#preset-real');

  // ⑥ 侧扫并跳到 TIR 临界点
  await page.click('#sweep-start');
  await sleep(300);
  await page.click('#sweep-tir');
  await sleep(500);
  const tir = await panelText();
  console.log('⑥ TIR 临界点面板:', tir);
  if (!tir.includes('全反射')) throw new Error('TIR 临界点未显示全反射');
  await page.screenshot({ path: `${SHOT}-6-tir.png` });

  // ⑦ 暂停态勾选 ±1.5° 对比
  await page.locator('#compare-swing').check();
  await sleep(400);
  await page.screenshot({ path: `${SHOT}-7-swing.png` });
  const angle = await page.locator('#sweep-angle-val').innerText();
  console.log('⑦ 暂停对比，当前 φ =', angle);

  // 手动滑到折射区 φ=38°（用 fill 触发完整 input 事件序列，避免直接改 value 的竞态）
  await page.locator('#sweep-angle').fill('38');
  await sleep(400);
  const shownAngle = await page.locator('#sweep-angle-val').innerText();
  console.log('⑧ 滑到 φ=38°，界面显示 φ =', shownAngle);
  const refractSide = await panelText();
  console.log('   折射区面板:', refractSide.slice(0, 120));
  if (!shownAngle.startsWith('38')) throw new Error('滑条未跳到 38°');
  if (refractSide.includes('全反射')) throw new Error('φ=38° 不应出现全反射');
  await page.screenshot({ path: `${SHOT}-8-refract.png` });

  // ⑨ 画布中心点选（先停扫查恢复自由相机）
  await page.click('#sweep-pause'); // 已是暂停；再点继续
  await sleep(100);
  // 直接在画布上点击中心偏左
  await page.mouse.click(750, 470);
  await sleep(400);
  console.log('⑨ 画布点选后面板:', await panelText());
  await page.screenshot({ path: `${SHOT}-9-click.png` });

  // ⑩ 关闭槽框显示开关不报错
  await page.locator('#toggle-frame').uncheck();
  await sleep(200);
  await page.locator('#toggle-frame').check();
  await page.screenshot({ path: `${SHOT}-10-final.png` });

  console.log('\n控制台错误数:', errors.length);
  errors.slice(0, 10).forEach((e) => console.log('  ', e));
  if (errors.length) throw new Error('存在运行时错误');
  await browser.close();
  console.log('\n✅ E2E 全部通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
