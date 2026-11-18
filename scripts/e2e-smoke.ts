/**
 * 浏览器端到端冒烟：启动真实页面，验证渲染、控件交互与 HUD 读数联动。
 * 运行：npx vite 后台启动后，npx tsx scripts/e2e-smoke.ts
 */
import { chromium } from 'playwright';

const BASE = 'http://[::1]:5217';

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });

  await page.goto(BASE);
  await page.waitForSelector('#scene');
  await page.waitForTimeout(800);

  // 1. 画布存在且有绘制内容
  const pixels = await page.evaluate(() => {
    const c = document.getElementById('scene') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < data.length; i += 4 * 500) {
      if (data[i] > 30 || data[i + 1] > 30 || data[i + 2] > 40) nonBg++;
    }
    return { width: c.width, height: c.height, nonBg };
  });
  console.log('1) 画布渲染:', pixels);
  if (pixels.nonBg < 50) throw new Error('画布几乎没有绘制内容');

  // 2. 模拟时间在运行模式下增长
  const t1 = (await page.textContent('#hud-simtime'))!.trim();
  await page.waitForTimeout(600);
  const t2 = (await page.textContent('#hud-simtime'))!.trim();
  console.log('2) 模拟时间推进:', t1, '->', t2);
  if (parseFloat(t2) <= parseFloat(t1)) throw new Error('模拟时间未推进');

  // 3. 暂停 -> 时间冻结 -> 单步只加 1/60
  await page.click('#btn-pause');
  const pausedT = parseFloat((await page.textContent('#hud-simtime'))!.trim());
  await page.waitForTimeout(400);
  const pausedT2 = parseFloat((await page.textContent('#hud-simtime'))!.trim());
  console.log('3a) 暂停冻结:', pausedT, '->', pausedT2);
  if (pausedT2 !== pausedT) throw new Error('暂停期间模拟时间仍在增长');
  await page.click('#btn-step');
  const stepT = parseFloat((await page.textContent('#hud-simtime'))!.trim());
  console.log('3b) 单步后:', stepT, '差值:', stepT - pausedT);
  // HUD 仅显示 3 位小数，断言放宽到舍入容差（真实步长由单元测试精确验证）
  if (Math.abs(stepT - pausedT - 1 / 60) > 0.0011) throw new Error('单步未恰好推进 1/60s');

  // 4. 拆开关节 J1
  await page.selectOption('#joint-select', '1');
  await page.click('#btn-break');
  await page.waitForTimeout(200);
  const statusAfterBreak = (await page.textContent('#hud-status'))!.trim();
  const devText = (await page.textContent('#hud-deviation'))!.trim();
  console.log('4) 拆开 J1 后状态:', statusAfterBreak, '|', devText);
  if (!statusAfterBreak.includes('拆开')) throw new Error('拆开后状态未更新');

  // 5. 恢复：先在暂停态用鼠标把断开的下游拖近，再点恢复
  const canvas = page.locator('#scene');
  const box = await canvas.boundingBox();
  // 断开的 B 端位置由 HUD 辅助：直接在画布中央偏下位置做几次拖拽手势
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx + 120, cy + 80);
  await page.mouse.down();
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(cx + 120 - i * 14, cy + 80 - i * 10, { steps: 3 });
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
  const devBeforeRestore = (await page.textContent('#hud-deviation'))!.trim();
  await page.click('#btn-restore');
  const toast = (await page.textContent('#toast'))!.trim();
  const statusAfterRestore = (await page.textContent('#hud-status'))!.trim();
  console.log('5) 拖拽后偏差:', devBeforeRestore, '| toast:', toast, '| 状态:', statusAfterRestore);

  // 6. 30/60Hz 切换按钮状态
  await page.click('#rate-30');
  const rate30Active = await page.locator('#rate-30').evaluate((el) => el.classList.contains('active'));
  await page.click('#rate-60');
  const rate60Active = await page.locator('#rate-60').evaluate((el) => el.classList.contains('active'));
  console.log('6) 显示节奏按钮 30Hz:', rate30Active, '60Hz:', rate60Active);
  if (!rate30Active || !rate60Active) throw new Error('显示节奏切换失败');

  // 7. 重力滑块联动
  await page.fill('#gravity', '20');
  await page.dispatchEvent('#gravity', 'input');
  const gLabel = (await page.textContent('#gravity-val'))!.trim();
  console.log('7) 重力标签:', gLabel);
  if (!gLabel.startsWith('20.0')) throw new Error('重力滑块未联动');

  // 8. 切换样例：带重物链出现 W 重物（通过关节下拉包含“重物关节”）
  await page.selectOption('#scenario-select', 'weighted');
  await page.waitForTimeout(300);
  const options = await page.locator('#joint-select option').allTextContents();
  console.log('8) 带重物链关节选项:', options);
  if (!options.some((o) => o.includes('重物关节'))) throw new Error('带重物样例缺少重物关节');

  // 9. 重置恢复全部连接
  await page.selectOption('#joint-select', '2');
  await page.click('#btn-break');
  await page.click('#btn-reset');
  await page.waitForTimeout(200);
  const resetStatus = (await page.textContent('#hud-status'))!.trim();
  console.log('9) 重置后状态:', resetStatus);
  if (!resetStatus.includes('已连接')) throw new Error('重置未恢复全部连接');

  if (errors.length) throw new Error(`页面报错:\n${errors.join('\n')}`);
  console.log('\n全部浏览器冒烟检查通过，无控制台错误。');
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
