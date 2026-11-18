import { chromium } from 'playwright';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5234', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
// 分离布局下各对象互不遮挡，组中心必落在自身几何上
await page.click('[data-layout="separated"]');
await page.waitForTimeout(300);

const result = await page.evaluate(() => {
  const hook = window.__outlineDemo;
  const objs = hook.getObjects();
  // 对每个对象，在其组中心投影周围小范围搜索一个命中自身 id 的像素，
  // 避开纽结环心、带孔环内孔、U/L 形凹槽等真实空洞
  return objs.map((o) => {
    const c = hook.projectCss(o.group.position.clone());
    let picked = 0;
    let hit = null;
    outer: for (let r = 0; r <= 60; r += 4) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const x = c.x + Math.cos(ang) * r;
        const y = c.y + Math.sin(ang) * r;
        const id = hook.pipeline.pick(
          x,
          y,
          objs.filter((q) => !q.hidden),
          hook.getCamera(),
        );
        if (id === o.id) {
          picked = id;
          hit = { x: Math.round(x), y: Math.round(y) };
          break outer;
        }
      }
    }
    return { id: o.id, name: o.name, picked, foundOwn: picked === o.id, at: hit };
  });
});
console.table(result.map(({ at, ...rest }) => rest));
const allExact = result.every((r) => r.foundOwn);
console.log(allExact ? 'PASS  所有对象拾取 id 精确匹配' : 'FAIL  存在 id 编码/拾取偏差');
await browser.close();
process.exit(allExact ? 0 : 1);
