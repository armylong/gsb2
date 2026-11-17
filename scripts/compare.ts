/** 验证对照视图：同一路径/参数，两个独立相机不同缩放，网格比例保持一致 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.SHOT_URL ?? 'http://127.0.0.1:5173/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    defaultViewport: { width: 1600, height: 900 },
  });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(500);

  // 选直角折线并打开对照视图
  await page.evaluate(() => {
    const sel = document.querySelector('select') as HTMLSelectElement;
    sel.value = 'right-angle';
    sel.dispatchEvent(new Event('change'));
  });
  await sleep(200);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('对照视图')) as HTMLButtonElement;
    btn.click();
  });
  await sleep(400);
  await page.screenshot({ path: '/tmp/cmp-dual.png' });

  // 读取两个视图的 zoom 与几何统计：网格顶点/三角形数必须完全相同
  const info = await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('.view-overlay')).map((o) => o.textContent);
    return { overlayCount: overlays.length, overlays };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
