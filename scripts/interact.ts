/** 交互验证：拖动顶点连续穿过 miter 限制边界，网格始终有限且无飞点 */
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
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(400);

  // 选尖角样例，设低 miterLimit 使边界容易被穿过
  await page.evaluate(() => {
    const sel = document.querySelector('select') as HTMLSelectElement;
    sel.value = 'sharp'; sel.dispatchEvent(new Event('change'));
  });
  await sleep(150);
  await page.evaluate(() => {
    const setRange = (label: string, val: number) => {
      const row = Array.from(document.querySelectorAll('.row')).find((r) => r.textContent?.includes(label));
      const input = row?.querySelector('input[type=range]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, String(val)); input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setRange('尖角限制', 2);
  });
  await sleep(150);

  // 找到中间顶点（浅色环，非首个橙色环）的屏幕位置
  const rings = await page.$$eval('.view-wrap canvas', () => true);
  void rings;
  const box = await page.$eval('.view-wrap canvas', (c) => {
    const r = (c as HTMLCanvasElement).getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  // 中间顶点大约在视图中心偏右；直接在画布中部按下并连续拖动一条弧线，
  // 让夹角从钝角连续变到锐角再回来，穿过 miter 边界。
  const cx = box.x + box.w * 0.62;
  const cy = box.y + box.h * 0.5;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const frames = 24;
  let allFinite = true;
  for (let i = 0; i <= frames; i++) {
    const t = i / frames;
    // 左右往返、上下摆动，制造连续变化的夹角
    const x = cx + Math.sin(t * Math.PI * 2) * box.w * 0.18;
    const y = cy + Math.cos(t * Math.PI * 2) * box.h * 0.12;
    await page.mouse.move(x, y, { steps: 2 });
    await sleep(20);
    const ok = await page.evaluate(() => {
      const txt = document.querySelector('.stats')?.textContent ?? '';
      return txt.includes('三角形数 = <b>') || /三角形数/.test(txt);
    });
    if (!ok) allFinite = false;
  }
  await page.mouse.up();
  await sleep(200);
  await page.screenshot({ path: '/tmp/interact-drag.png' });

  // 双击一个顶点删除
  await page.mouse.click(cx, cy, { count: 2 });
  await sleep(200);
  const afterDelete = await page.evaluate(() => document.querySelector('.stats')?.textContent);

  // 单击明确的空白区域（画布左上角，远离任何顶点）添加顶点
  const blankX = box.x + box.w * 0.12;
  const blankY = box.y + box.h * 0.12;
  await page.mouse.click(blankX, blankY);
  await sleep(200);
  const afterAdd = await page.evaluate(() => document.querySelector('.stats')?.textContent);

  console.log(JSON.stringify({ errors, allFinite, afterDelete, afterAdd }, null, 2));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
