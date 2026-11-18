import { chromium } from 'playwright';
const URL = `http://127.0.0.1:${process.env.PORT || 5173}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(URL);
await page.waitForSelector('#viewport canvas');
await sleep(600);

// 直接驱动打包后的真实求解器：极小 r、大 near、抬头看顶板
// 该几何下近裁面上角的垂直触达超过球体，九点检查先于球体扫掠触发
const result = await page.evaluate(() => {
  const slab = { min: { x: -8, y: 1.35, z: -8 }, max: { x: 8, y: 1.75, z: 8 }, name: '顶板' };
  return window.__camSolve({
    pivot: { x: 0, y: 1.0, z: 0 },
    yaw: 0,
    pitch: -0.25,
    desired: 5.0,
    radius: 0.05,
    near: 0.3,
    boxes: [slab],
  });
});
console.log('[探针-近裁面接管]', JSON.stringify(result));
console.assert(result.frustumClamped === true, '近裁面九点应先于球体接管');
console.assert(result.constrained === false, '未到最小距离，不应受限');
console.assert(result.minClearance >= -1e-4, '位姿不穿模');

// 对照：调大碰撞半径后，球体先约束，近裁面不再需要回退
const resultBigR = await page.evaluate(() => {
  const slab = { min: { x: -8, y: 1.35, z: -8 }, max: { x: 8, y: 1.75, z: 8 }, name: '顶板' };
  return window.__camSolve({
    pivot: { x: 0, y: 1.0, z: 0 },
    yaw: 0, pitch: -0.25, desired: 5.0, radius: 0.4, near: 0.3, boxes: [slab],
  });
});
console.log('[对照-大半径球体接管]', 'frustumClamped=', resultBigR.frustumClamped);
console.assert(resultBigR.frustumClamped === false, '大半径时球体先约束');

console.log('错误:', errors.length ? errors : '无');
await browser.close();
