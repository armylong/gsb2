/** 人工目检截图：三场景 × 关键模式，输出到 tmp/verify/manual/。npm run verify 不依赖此脚本 */
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'tmp', 'verify', 'manual');
mkdirSync(OUT, { recursive: true });

function findChild(dir, prefix) {
  if (!existsSync(dir)) return null;
  const n = readdirSync(dir).find((x) => x.startsWith(prefix));
  return n ? join(dir, n) : null;
}
const cache = join(homedir(), 'Library/Caches/ms-playwright');
const shellBin = join(findChild(cache, 'chromium_headless_shell-') || '', findChild(findChild(cache, 'chromium_headless_shell-') || '', 'chrome-headless-shell-mac-') || '', 'chrome-headless-shell');
const browserPath = existsSync(shellBin)
  ? shellBin
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const server = await createServer({ root: ROOT, server: { port: 5194, host: '127.0.0.1', strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch({
  headless: true,
  executablePath: browserPath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto('http://127.0.0.1:5194/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ssaoDebug !== undefined);

  const scenes = ['corner', 'sphere', 'cubes'];
  for (const scene of scenes) {
    await page.click(`#sceneRow [data-scene="${scene}"]`);
    await page.waitForTimeout(200);
    const count = await page.evaluate(() => document.getElementById('sceneCount').textContent);
    console.log(scene, '->', count);

    // 分屏 off|on
    await page.check('input[name="view"][value="split"]');
    await page.selectOption('#leftMode', 'off');
    await page.selectOption('#rightMode', 'on');
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(OUT, `${scene}-split.png`) });

    // 灰度图
    await page.check('input[name="view"][value="gray"]');
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(OUT, `${scene}-gray.png`) });
  }

  // 平滑高档位（双边模糊）在密排方块上的效果
  await page.click('#sceneRow [data-scene="cubes"]');
  await page.check('input[name="view"][value="on"]');
  await page.selectOption('#smooth', 'high');
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, 'cubes-bilateral-high.png') });
  await page.selectOption('#smooth', 'off');
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, 'cubes-smooth-off.png') });

  console.log('截图目录:', OUT);
} finally {
  await browser.close();
  await server.close();
}
