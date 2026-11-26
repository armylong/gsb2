/**
 * 浏览器端到端验证：启动后由 `node scripts/e2e.ts` 手动运行（非单测套件）。
 * 需要 dev server 已在 127.0.0.1:5173 运行。
 */
import { chromium } from 'playwright-core';

const EXE = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const URL = 'http://127.0.0.1:5173/';

const results: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const consoleErrors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// 1) 初始默认布置：有效、带长与接触包角已显示
const lengthText = await page.locator('#r-length').textContent();
check('默认布置带长已计算', !!lengthText && Number(lengthText) > 10, lengthText ?? '');
const contacts = await page.locator('.contact-line').allInnerTexts();
check('三只轮均显示接触包角', contacts.length === 3, contacts.join(' | '));
check('无冲突面板', await page.locator('#conflict-box.hidden').count() === 1);
check('控制台无错误', consoleErrors.length === 0, consoleErrors.join('; '));
await page.screenshot({ path: 'shots/01-default.png' });

// 2) 走带：phase 随时间变化，带长不变
const phaseBefore = Number((await page.locator('#r-phase').textContent())!);
await page.waitForTimeout(700);
const phaseAfter = Number((await page.locator('#r-phase').textContent())!);
check('走带 phase 随时间推进', phaseAfter > phaseBefore, `${phaseBefore.toFixed(3)} -> ${phaseAfter.toFixed(3)}`);
const lengthStable = await page.locator('#r-length').textContent();
check('走带中带长稳定', lengthStable === lengthText);

// 3) 暂停
await page.click('#play');
const pausedPhase = Number((await page.locator('#r-phase').textContent())!);
await page.waitForTimeout(400);
const stillPaused = Number((await page.locator('#r-phase').textContent())!);
check('暂停后 phase 冻结', Math.abs(stillPaused - pausedPhase) < 1e-9);

// 4) 单步 +：精确推进 0.2
await page.click('#step-fwd');
const stepped = Number((await page.locator('#r-phase').textContent())!);
check('单步 + 推进 0.200', Math.abs(stepped - (pausedPhase + 0.2)) < 1e-9, `${pausedPhase} -> ${stepped}`);

// 5) 反转 + 单步 -
await page.click('#reverse');
const dirText = await page.locator('#r-dir').textContent();
check('方向显示反转', dirText!.includes('反向'), dirText ?? '');
await page.click('#step-back');
const back = Number((await page.locator('#r-phase').textContent())!);
check('反转后单步 - 实际前进（负方向再取负）', Math.abs(back - (stepped + 0.2)) < 1e-9, `${stepped} -> ${back}`);
await page.click('#reverse'); // 恢复正向
await page.click('#play'); // 恢复运行

// 6) 选择刻度并读取到接缝距离
await page.selectOption('#select-marker', '10');
await page.waitForTimeout(100);
const dist1 = await page.locator('#r-dist').textContent();
check('选中 #10 后显示到接缝距离', !!dist1 && Number(dist1) >= 0 && Number(dist1) < Number(lengthText), dist1 ?? '');
await page.screenshot({ path: 'shots/02-selected.png' });

// 7) 镜头跟随：focus 后 controls.target 移近选中刻度
const targetBefore = await page.evaluate(() => (window as any).beltDebug.scene['controls'].target.toArray());
await page.click('#focus');
await page.waitForTimeout(900);
const targetAfter = await page.evaluate(() => (window as any).beltDebug.scene['controls'].target.toArray());
const moved = Math.hypot(targetAfter[0] - targetBefore[0], targetAfter[1] - targetBefore[1]);
check('镜头转向选中刻度', moved > 0.5, `target ${targetBefore.map((n: number) => n.toFixed(2)).join(',')} -> ${targetAfter.map((n: number) => n.toFixed(2)).join(',')}`);
await page.screenshot({ path: 'shots/03-focused.png' });

// 8) 几何变更：拖动中间轮半径滑杆，带长变化且选中保留
await page.fill('#mr', '1.6');
await page.dispatchEvent('#mr', 'input');
await page.waitForTimeout(300);
const length2 = await page.locator('#r-length').textContent();
check('半径变更后带长更新', Number(length2) !== Number(lengthText), `${lengthText} -> ${length2}`);
const stillSelected = await page.evaluate(() => (window as any).beltDebug.getStatus().selectedLabel);
check('几何变更后选中标记保留', stillSelected === 10, `selected=${stillSelected}`);
await page.screenshot({ path: 'shots/04-resized.png' });

// 9) 失效摆位：两轮距离不足 → 冲突面板指出轮编号，带长保留上次结果
await page.click('.preset-grid button:nth-child(4)');
await page.waitForTimeout(300);
const conflictVisible = await page.locator('#conflict-box:not(.hidden)').count();
const conflictHtml = await page.locator('#conflict-list').innerText();
const keptLength = await page.locator('#r-length').textContent();
check('距离不足时显示冲突面板', conflictVisible === 1);
check('冲突信息指出轮子编号', /轮\s*1/.test(conflictHtml) && /轮\s*2/.test(conflictHtml), conflictHtml.replace(/\n/g, ' '));
check('保留上次有效带长', keptLength === length2, `kept=${keptLength}`);
await page.screenshot({ path: 'shots/05-conflict-overlap.png' });

// 10) 失效摆位：偏心包角失效
await page.click('.preset-grid button:nth-child(2)');
await page.waitForTimeout(300);
const html2 = await page.locator('#conflict-list').innerText();
check('偏心摆位报告包角/交叉冲突并指出轮 1', /轮\s*1/.test(html2), html2.replace(/\n/g, ' '));
await page.screenshot({ path: 'shots/06-conflict-wrap.png' });

// 11) 失效后恢复默认：带路重新有效
await page.click('.preset-grid button:nth-child(1)');
await page.waitForTimeout(300);
const okAgain = await page.locator('#conflict-box.hidden').count();
const length3 = await page.locator('#r-length').textContent();
check('恢复默认后冲突消失', okAgain === 1);
check('恢复后重新计算带长', Math.abs(Number(length3) - Number(lengthText)) < 1e-9, `${length3} vs ${lengthText}`);

// 12) 接缝距离在走带中连续变化且周期性归零附近
await page.selectOption('#select-marker', '0');
await page.waitForTimeout(100);
const d0 = Number((await page.locator('#r-dist').textContent())!);
await page.waitForTimeout(900);
const d1 = Number((await page.locator('#r-dist').textContent())!);
check('到接缝距离随走带变化', Math.abs(d1 - d0) > 1e-6, `${d0.toFixed(3)} -> ${d1.toFixed(3)}`);
check('距离始终在 [0, L) 内', d0 >= 0 && d0 < Number(length3) && d1 >= 0 && d1 < Number(length3));

// 13) 运动一致性：单步 0.2 后，选中标记沿带路的弧长位移恰为 0.2；纹理偏移与标记同步
const markerPos = () =>
  page.evaluate(() => {
    const s = (window as any).beltDebug.scene as any;
    let ringPos: number[] | null = null;
    s.beltRoot.traverse((o: any) => {
      if (o.isMesh && o.geometry?.type === 'PlaneGeometry' && o.geometry?.parameters?.width === 0.78 && o.visible) {
        ringPos = [o.position.x, o.position.y];
      }
    });
    return { ringPos, texOffset: s.beltTexture ? s.beltTexture.offset.x : null, pathLen: s.path.length };
  });

await page.selectOption('#select-marker', '5');
await page.waitForTimeout(100);
await page.click('#play'); // 暂停，避免动画干扰
const before = await markerPos();
await page.click('#step-fwd');
const after = await markerPos();
if (before.ringPos && after.ringPos) {
  const chord = Math.hypot(after.ringPos[0] - before.ringPos[0], after.ringPos[1] - before.ringPos[1]);
  check('单步后选中标记发生位移', chord > 1e-6, `弦长=${chord.toFixed(4)}`);
  check('短步长下弦长接近弧长 0.2（弯段略小）', chord > 0.15 && chord <= 0.2 + 1e-6, `弦长=${chord.toFixed(4)}`);
} else {
  check('单步后选中标记发生位移', false, '未找到选中环');
}
// offset.x = -phase/L，允许跨 0 回绕
let rawDelta = (before.texOffset - after.texOffset) * after.pathLen;
rawDelta = ((rawDelta % after.pathLen) + after.pathLen) % after.pathLen;
const offsetDelta = Math.abs(rawDelta - 0.2);
check('纹理 offset 换算位移 = 步进量 0.2', offsetDelta < 1e-6, `delta=${offsetDelta.toExponential(2)}`);
await page.click('#play'); // 恢复运行

check('全程控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join('; '));

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
