/**
 * 仅用于本地可视化验证：驱动系统 Chrome 切换面板组合并截图。
 * 不进入生产构建，不依赖外部服务。运行：npx tsx scripts/shoot.ts
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.SHOT_URL ?? 'http://127.0.0.1:5173/';
const OUT = '/tmp';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function clickButton(page: puppeteer.Page, text: string) {
  const btn = await page.$$eval('button', (bs, t) => {
    const b = bs.find((x) => x.textContent?.trim() === t);
    if (b) (b as HTMLButtonElement).click();
    return !!b;
  }, text);
  if (!btn) throw new Error(`button not found: ${text}`);
  await sleep(120);
}

async function selectSample(page: puppeteer.Page, name: string) {
  await page.select('select', await page.$eval('select option', () => '') as unknown as string).catch(() => undefined);
  await page.evaluate((n) => {
    const sel = document.querySelector('select') as HTMLSelectElement;
    const opt = Array.from(sel.options).find((o) => o.textContent === n);
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); }
  }, name);
  await sleep(150);
}

async function setCheckbox(page: puppeteer.Page, labelText: string, checked: boolean) {
  await page.evaluate(([lt, ck]) => {
    const rows = Array.from(document.querySelectorAll('.check-row'));
    const row = rows.find((r) => r.textContent?.includes(lt));
    const cb = row?.querySelector('input[type=checkbox]') as HTMLInputElement;
    if (cb && cb.checked !== ck) cb.click();
  }, [labelText, checked]);
  await sleep(120);
}

async function setRange(page: puppeteer.Page, labelText: string, value: number) {
  await page.evaluate(([lt, val]) => {
    const rows = Array.from(document.querySelectorAll('.row'));
    const row = rows.find((r) => r.textContent?.includes(lt));
    const input = row?.querySelector('input[type=range]') as HTMLInputElement;
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, String(val));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, [labelText, value]);
  await sleep(120);
}

async function shot(page: puppeteer.Page, name: string) {
  await sleep(200);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', name);
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--window-size=1600,900'],
    defaultViewport: { width: 1600, height: 900 },
  });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(500);

  // 1. 直线 + 圆头
  await selectSample(page, '直线');
  await clickButton(page, '圆头');
  await shot(page, 's1-line-roundcap');

  // 2. 直角折线 + 圆角连接
  await selectSample(page, '直角折线');
  await clickButton(page, '圆角');
  await shot(page, 's2-rightangle-roundjoin');

  // 3. 尖角折线 + 尖角，低 miterLimit 触发削平（该样例 ratio≈2.69）
  await selectSample(page, '尖角折线（小夹角）');
  await clickButton(page, '尖角');
  await setRange(page, '尖角限制', 1.5);
  await shot(page, 's3-sharp-miter-low');
  // 提高限制，保留尖角
  await setRange(page, '尖角限制', 4);
  await shot(page, 's4-sharp-miter-high');

  // 4. 闭合矩形 + 虚线，验证接缝与跨缝节奏
  await selectSample(page, '闭合矩形');
  await setCheckbox(page, '启用虚线', true);
  await setRange(page, '线段长度', 2.5);
  await setRange(page, '空隙长度', 1.5);
  await shot(page, 's5-rect-dashed');

  // 5. 闭合尖角三角形 + 圆头 + 虚线 offset
  await selectSample(page, '闭合尖角三角形');
  await setRange(page, '起始偏移', 1);
  await shot(page, 's6-triangle-dash-offset');

  // 6. 多转角 + 方头 + 削平 + 虚线
  await selectSample(page, '多转角折线');
  await clickButton(page, '方头');
  await clickButton(page, '削平');
  await shot(page, 's7-multi-square-bevel-dash');

  // 7. 重复点健壮性
  await selectSample(page, '含连续重复点');
  await clickButton(page, '圆头');
  await clickButton(page, '圆角');
  await shot(page, 's8-duplicates');

  // 收集页面统计与验证结果
  const info = await page.evaluate(() => {
    const stats = document.querySelector('.stats')?.textContent ?? '';
    const summary = document.querySelector('#summary')?.textContent ?? '';
    const checks = Array.from(document.querySelectorAll('.check-item')).map((el) => ({
      name: el.querySelector('.head span')?.textContent,
      badge: el.querySelector('.badge')?.textContent,
    }));
    return { stats, summary, checks };
  });
  console.log(JSON.stringify(info, null, 2));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
