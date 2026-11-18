/**
 * 视觉截图 + 远距离拒绝重连的页面级验证。
 * 输出：tmp-shots/{short,weighted,broken,reconnect-denied}.png
 */
import { chromium } from 'playwright';

const BASE = 'http://[::1]:5217';

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(BASE);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'tmp-shots/short.png' });

  // 带重物样例
  await page.selectOption('#scenario-select', 'weighted');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'tmp-shots/weighted.png' });

  // 暂停、拆开中间关节、等待下游漂远
  await page.click('#btn-pause');
  await page.selectOption('#joint-select', '3');
  await page.click('#btn-break');
  const toast1 = (await page.textContent('#toast'))!.trim();
  await page.screenshot({ path: 'tmp-shots/broken.png' });

  // 单步多次让下游自由坠落拉开距离
  for (let i = 0; i < 90; i++) await page.click('#btn-step');
  const deviation = (await page.textContent('#hud-deviation'))!.trim();
  const status = (await page.textContent('#hud-status'))!.trim();
  await page.click('#btn-restore');
  await page.waitForTimeout(100);
  const toast2 = (await page.textContent('#toast'))!.trim();
  await page.screenshot({ path: 'tmp-shots/reconnect-denied.png' });

  console.log(JSON.stringify({ toast1, deviation, status, toast2 }, null, 2));
  if (!toast2.includes('拒绝重连')) throw new Error('未出现远距离拒绝重连提示');
  if (!status.includes('拒绝重连')) throw new Error('HUD 状态未反映拒绝重连');

  await browser.close();
  console.log('截图已写入 tmp-shots/');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
