// 无头冒烟验证: 真实浏览器加载页面, 检查渲染、单步、暂停、演示中断流程与拖动
// 运行: node smoke/smoke.mjs  (需先 npm run build)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shotDir = path.join(root, 'smoke', 'shots');
fs.mkdirSync(shotDir, { recursive: true });

const fails = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fails.push(name);
};

const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], {
  cwd: root,
  shell: true,
});
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
await page.waitForSelector('#tree-panel .tree-row');

// 1) 初始渲染: 15 个树节点
const rowCount = await page.locator('#tree-panel .tree-row').count();
check('行为树渲染 15 个节点', rowCount === 15, `实际 ${rowCount}`);
check('无控制台错误', consoleErrors.length === 0, consoleErrors.join('; '));

// 2) 单步: 连点 3 次, 周期 #1 -> #3, 模拟时间 1.5s
await page.click('#btn-step');
await page.click('#btn-step');
await page.click('#btn-step');
const hud1 = await page.locator('#hud').innerText();
check('单步 3 次后周期=#3', /决策周期:\s*#3/.test(hud1), hud1.replace(/\n/g, ' '));
check('模拟时间=1.5s', /模拟时间:\s*1\.5s/.test(hud1));
const runningRows = await page.locator('.tree-row.s-running').count();
check('有节点处于执行中', runningRows >= 3, `running 行数 ${runningRows}`);
await page.screenshot({ path: path.join(shotDir, '01-after-steps.png') });

// 3) 暂停冻结: 读时间 -> 等 1.2s -> 再读, 必须不变
const timeBefore = (await page.locator('#hud').innerText()).match(/模拟时间:\s*([\d.]+)s/)[1];
await page.waitForTimeout(1200);
const timeAfter = (await page.locator('#hud').innerText()).match(/模拟时间:\s*([\d.]+)s/)[1];
check('暂停时模拟时间冻结', timeBefore === timeAfter, `${timeBefore} vs ${timeAfter}`);

// 4) 演示2: 追逐中低生命 —— 自动播放到 tick 4 触发 HP=20 事件
await page.click('[data-demo="chase-lowhp"]');
await page.waitForTimeout(3200); // 覆盖到 tick ~6
const logText = await page.locator('#log-panel').innerText();
check('日志记录低生命抢占的中断', logText.includes('中断') && logText.includes('移动→目标'), '');
check('日志解释了分支切换原因', logText.includes('分支切换') && logText.includes('低生命撤退'), '');
const interruptedBadge = await page.locator('.tree-row .badge', { hasText: '被中断' }).count();
check('树中出现"被中断"状态标记', interruptedBadge >= 1);
await page.screenshot({ path: path.join(shotDir, '02-chase-lowhp.png') });

// 继续播放到 HP 恢复事件(tick 14)
await page.waitForTimeout(4500);
const logText2 = await page.locator('#log-panel').innerText();
check('HP 恢复后撤退守卫条件失效并退出', logText2.includes('守卫条件失效') || logText2.includes('主动退出'), '');
await page.screenshot({ path: path.join(shotDir, '03-hp-recover.png') });

// 5) 重置: 周期归零, 无 running/interrupted 残留
await page.click('#btn-reset');
const hudReset = await page.locator('#hud').innerText();
check('重置后周期=#0', /决策周期:\s*#0/.test(hudReset));
const leftover = await page.locator('.tree-row.s-running, .tree-row.s-interrupted').count();
check('重置后无执行中/被中断残留', leftover === 0, `残留 ${leftover}`);

// 6) 优先级调整: 巡逻上移到追逐之前, 下一周期日志提示顺序变化
const patrolRow = page.locator('.prio-item[data-branch="patrol"]');
await patrolRow.locator('button[data-move="up"]').click();
await page.click('#btn-step');
const logPrio = await page.locator('#log-panel').innerText();
check('优先级调整被记录且下周期生效', logPrio.includes('分支优先级已调整') && logPrio.includes('retreat > patrol > chase'), logPrio.replace(/\n/g, ' ').slice(-120));
const patrolActive = await page.locator('.tree-row.s-running').first().innerText();
check('巡逻分支按新顺序被选中', /巡逻/.test(patrolActive), patrolActive);

// 7) 拖动目标: 在 canvas 上按下红点并移动
const box = await page.locator('#scene').boundingBox();
await page.mouse.move(box.x + 360, box.y + 180);
await page.mouse.down();
await page.mouse.move(box.x + 240, box.y + 120, { steps: 6 });
await page.mouse.up();
const hudDrag = await page.locator('#hud').innerText();
check('拖动后目标位置更新', /移动目标|NPC 位置/.test(hudDrag));
await page.screenshot({ path: path.join(shotDir, '04-drag-target.png') });

// 8) 阈值滑杆: 改低生命阈值并单步, 出现"未生效"提示后提交
await page.locator('#cfg-hp').fill('90');
const pendingNote = await page.locator('.pending-note').count();
check('修改配置出现"下一周期生效"提示', pendingNote === 1);
await page.click('#btn-step');
const ctxAfter = await page.locator('#context-panel').innerText();
check('新阈值在 tick 后生效', ctxAfter.includes('撤退阈值 90'), ctxAfter.slice(0, 80));

// 9) 演示1: 巡逻中发现目标 —— tick4 目标进入警戒, 巡逻被追逐抢占
await page.click('#btn-reset');
await page.click('[data-demo="patrol-detect"]');
await page.waitForTimeout(3000); // 覆盖 tick ~6
const logDemo1 = await page.locator('#log-panel').innerText();
check('演示1: 追逐抢占巡逻并解释原因', logDemo1.includes('分支切换') && logDemo1.includes('范围内追逐'), logDemo1.replace(/\n/g, ' ').slice(-100));
check('演示1: 巡逻侧出现中断记录', /中断/.test(logDemo1));
await page.screenshot({ path: path.join(shotDir, '05-patrol-detect.png') });

// 10) 演示3: 目标离开警戒范围 —— 守卫条件重检失败, 追逐中断回巡逻
await page.click('#btn-reset');
await page.click('[data-demo="target-leave"]');
await page.waitForTimeout(3500); // 覆盖 tick ~7, 事件在 tick5
const logDemo3 = await page.locator('#log-panel').innerText();
check('演示3: 追逐守卫条件失效', logDemo3.includes('守卫条件失效') && logDemo3.includes('警戒'), '');
const chaseInterrupts = await page.locator('#log-panel .log-line.interrupt', { hasText: '[移动→目标]' }).count();
check('演示3: 追逐动作中断恰好一次', chaseInterrupts === 1, `计数 ${chaseInterrupts}`);
const chaseNode = page.locator('.tree-row[data-node-id="9"] .badge');
check('演示3: 追逐节点呈现被中断/未执行(非持续运行)', !/执行中/.test(await chaseNode.innerText()), await chaseNode.innerText());
await page.screenshot({ path: path.join(shotDir, '06-target-leave.png') });

check('全程无控制台错误', consoleErrors.length === 0, consoleErrors.join('; '));

await browser.close();
server.kill();
console.log(fails.length ? `\n${fails.length} 项失败: ${fails.join('; ')}` : '\n全部冒烟检查通过');
process.exit(fails.length ? 1 : 0);
