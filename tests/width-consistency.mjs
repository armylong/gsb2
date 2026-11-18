// 描边宽度专项：DPR=1 与 DPR=2 下，轮廓蒙版环带在屏幕 CSS 像素中的厚度应基本一致（1..6px）。
// 通过页面内测试钩子直接回读轮廓 alpha 蒙版，对蒙版做切比雪夫距离变换求环带厚度，
// 不受合成颜色混合与抗锯齿光晕影响。容忍 ±1.5 CSS 像素的边缘误差。
import { chromium } from 'playwright';

async function measure(dpr) {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: dpr,
  });
  await page.goto('http://127.0.0.1:5234', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.click('[data-layout="separated"]');
  await page.locator('#object-list li').nth(0).click(); // 球体

  const out = [];
  for (const w of [1, 2, 4, 6]) {
    const slider = page.locator('#width-slider');
    await slider.fill(String(w));
    await slider.dispatchEvent('input');
    await page.waitForTimeout(200);
    const thickness = await page.evaluate(({ dpr: dprValue, widthCss }) => {
      const hook = window.__outlineDemo;
      const mask = hook.pipeline.captureOutlineMask(
        hook.getScene(),
        hook.getCamera(),
        hook.getObjects().filter((o) => !o.hidden),
        'visible',
        widthCss,
        dprValue,
      );
      const { width: W, height: H, alpha } = mask;
      const marked = new Uint8Array(W * H);
      let ringPixels = 0;
      for (let p = 0; p < W * H; p++) {
        marked[p] = alpha[p] > 40 ? 1 : 0;
        if (marked[p]) ringPixels++;
      }
      // 轮廓周长 ≈ 蒙版中与非蒙版像素四邻接的边界像素数
      let perimeter = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x;
          if (!marked[p]) continue;
          const touchesOutside =
            (x > 0 ? !marked[p - 1] : true) ||
            (x < W - 1 ? !marked[p + 1] : true) ||
            (y > 0 ? !marked[p - W] : true) ||
            (y < H - 1 ? !marked[p + W] : true);
          if (touchesOutside) perimeter++;
        }
      }
      // 环带平均厚度 = 环带面积 / 周长（圆盘外扩环的面积 ≈ 周长 × 厚度）
      return Math.max(1, ringPixels / Math.max(1, perimeter));
    }, { dpr, widthCss: w });
    out.push({ setCss: w, devicePx: Number(thickness.toFixed(2)), cssPx: thickness / dpr });
  }
  await browser.close();
  return out;
}

const r1 = await measure(1);
const r2 = await measure(2);
console.log('DPR=1:', JSON.stringify(r1));
console.log('DPR=2:', JSON.stringify(r2));

let ok = true;
for (let i = 0; i < r1.length; i++) {
  const expect = r1[i].setCss;
  // 设备像素半径 = max(1, round(宽度*dpr/2))，再换算回 CSS 像素；
  // 1px@DPR2 的期望半径为 0.5 CSSpx，因为 1 设备像素是最小可渲染单位
  const expectedCssRadius = (dpr) => Math.max(1, Math.round((expect * dpr) / 2)) / dpr;
  const tol = 0.6;
  // 1px 时两种 DPR 都只能渲染 1 个设备像素（最小单位），允许相等；其余宽度要求随 DPR 增长
  const dprGrowth =
    expect === 1
      ? r2[i].devicePx >= r1[i].devicePx
      : r2[i].devicePx >= r1[i].devicePx * 1.6;
  const pass =
    Math.abs(r1[i].cssPx - expectedCssRadius(1)) <= tol &&
    Math.abs(r2[i].cssPx - expectedCssRadius(2)) <= tol &&
    dprGrowth;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  设定 ${expect}px（期望 CSS 半径 DPR1=${expectedCssRadius(1)}，DPR2=${expectedCssRadius(2)}）：` +
      `实测 DPR1=${r1[i].cssPx.toFixed(2)}，DPR2=${r2[i].cssPx.toFixed(2)}` +
      `（设备像素 ${r1[i].devicePx} -> ${r2[i].devicePx}）`,
  );
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
