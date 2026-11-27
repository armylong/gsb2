/** 浏览器冒烟测试:起 vite,截图各视角,收集控制台错误 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:5199');
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/anamorph-free.png' });

// 观察点视角:画面应拼回目标图(参考面自动隐藏)
await page.click('#presetEye');
await page.waitForTimeout(400);
console.log('观察点视角下参考面可见性:', await page.evaluate(() => window.__bundle.imagePlane.visible));
await page.screenshot({ path: '/tmp/anamorph-eye.png' });

// 俯视:画应留在地面/台阶上
await page.click('#presetTop');
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/anamorph-top.png' });

// 遮挡示例
await page.click('#loadOccluded');
await page.waitForTimeout(600);
await page.click('#presetEye');
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/anamorph-occluded-eye.png' });
await page.click('#presetFree');
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/anamorph-occluded-free.png' });

// 点选目标图中央,检查点选结果(观察点视角下参考面虽隐藏,仍可点选)
await page.click('#presetEye');
await page.waitForTimeout(300);
await page.mouse.click(530, 450);
await page.waitForTimeout(300);
const info = await page.textContent('#info');
console.log('点选结果:', info);
await page.screenshot({ path: '/tmp/anamorph-inspect.png' });

// 核对第一张稿
await page.click('#loadDefault');
await page.waitForTimeout(600);
const verifyBtns = await page.$$('[data-act=verify]');
await verifyBtns[verifyBtns.length - 1].click();
await page.waitForTimeout(300);
console.log('核对输出:', await page.textContent('#verifyOut'));

// 默认视角下点选目标图中央,应有落点
await page.click('#presetEye');
await page.waitForTimeout(300);
await page.mouse.click(530, 450);
await page.waitForTimeout(300);
console.log('默认视角点选:', await page.textContent('#info'));
await page.screenshot({ path: '/tmp/anamorph-inspect.png' });

console.log(errors.length ? `控制台错误:\n${errors.join('\n')}` : '无控制台错误');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
