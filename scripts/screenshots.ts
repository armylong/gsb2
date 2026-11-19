/** 生成三张关键状态截图：球面强简化热色、弯曲片叠加、线框对照。 */
import puppeteer from 'puppeteer-core';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE_URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5175/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--window-size=1600,1000'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.waitForSelector('#busy-overlay.hidden', { timeout: 20000 });

  // 球面 25% 强简化 -> 距离热色
  await page.$eval('#ratio-slider', (el) => {
    const i = el as HTMLInputElement;
    i.value = '25';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#simplify-button');
  await page.waitForSelector('#busy-overlay.hidden', { timeout: 20000 });
  await sleep(600);
  await page.screenshot({ path: '/tmp/chrome-test/shot-sphere-heat.png' });

  // 弯曲片 + LockBorder + 叠加模式
  await page.click('button.sample[data-sample="sheet"]');
  await page.waitForSelector('#busy-overlay.hidden', { timeout: 20000 });
  await sleep(400);
  await page.$eval('#ratio-slider', (el) => {
    const i = el as HTMLInputElement;
    i.value = '50';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#lock-border');
  await page.waitForSelector('#busy-overlay.hidden', { timeout: 20000 });
  await sleep(400);
  // 显式执行一次简化，确保当前是 50% 锁定结果而非参照
  await page.click('#simplify-button');
  await page.waitForSelector('#busy-overlay.hidden', { timeout: 20000 });
  await sleep(400);
  await page.click('#mode-overlay');
  await sleep(600);
  await page.screenshot({ path: '/tmp/chrome-test/shot-sheet-overlay.png' });

  // 线框（保持 50% 锁定简化结果）
  await page.click('#mode-split');
  await sleep(300);
  await page.click('#wireframe-toggle');
  await sleep(400);
  await page.screenshot({ path: '/tmp/chrome-test/shot-sheet-wire.png' });

  await browser.close();
  console.log('screenshots done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
