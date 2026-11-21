/**
 * 无浏览器验证：直接驱动纯逻辑引擎。
 * 运行：npm run verify  （node --experimental-strip-types tests/verify.ts）
 */
import { Simulation, CELL_CAPACITY } from '../src/engine.ts';
import { PRESETS, GRID_W, GRID_H } from '../src/presets.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    failures.push(`${name} ${detail}`);
    console.log(`  ✘ ${name} ${detail}`);
  }
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function runN(sim: Simulation, n: number): void {
  for (let i = 0; i < n; i++) sim.advance();
}

function assertInvariants(sim: Simulation, label: string): void {
  const err = sim.checkInvariants();
  check(`${label}：无负量 / 无超容量 / 墙格无液体`, err === null, err ?? '');
}

function presetById(id: string): Simulation {
  const p = PRESETS.find((x) => x.id === id)!;
  return p.build();
}

// ---------- 1. 不变量：任何场景跑任意步数都不能出现负量或超容量 ----------
console.log('\n[1] 容量与非负不变量');
for (const p of PRESETS) {
  const sim = p.build();
  runN(sim, 2000);
  assertInvariants(sim, `预设「${p.name}」2000 步后`);
}

// 压力测试：往每个非墙格强行灌满两种液体（经夹紧入口），再推进
{
  const sim = presetById('empty');
  for (let y = 1; y < GRID_H - 1; y++) {
    for (let x = 1; x < GRID_W - 1; x++) {
      sim.addLiquid(x, y, 'w', 0.8);
      sim.addLiquid(x, y, 'o', 0.8); // 容量只有 1，第二次必须被夹紧
    }
  }
  runN(sim, 500);
  assertInvariants(sim, '过载加注 500 步后');
  const t = sim.totals();
  check('过载加注后总量不超过可用容量', t.w + t.o <= t.capacity + 1e-9);
}

// ---------- 2. U 形管：无进出口，中途移开隔板，两液体各自守恒 ----------
console.log('\n[2] U形管守恒与分层（中途移开隔板）');
{
  const sim = presetById('utube');
  const before = sim.totals();
  check('U形管初始无任何口', sim.ports.size === 0);
  runN(sim, 500); // 隔板还在，两侧应完全静止
  const sealed = sim.totals();
  check('隔板密封阶段水量守恒', approx(sealed.w, before.w));
  check('隔板密封阶段油量守恒', approx(sealed.o, before.o));

  // 中途移开隔板
  for (let y = 1; y < GRID_H - 1; y++) sim.setWall(10, y, false);
  runN(sim, 3000);
  const after = sim.totals();
  check('移开隔板后水量仍守恒（无进出口）', approx(after.w, before.w),
    `w: ${before.w} -> ${after.w}`);
  check('移开隔板后油量仍守恒（无进出口）', approx(after.o, before.o),
    `o: ${before.o} -> ${after.o}`);
  check('净口流量为 0', sim.netPortFlow().w === 0 && sim.netPortFlow().o === 0);

  // 密度分层：底排应是纯水；油只出现在界面行及以上（界面行为均匀混合行）
  let bottomRowOil = 0;
  let bottomRowWater = 0;
  const bottomY = GRID_H - 2;
  const interfaceY = GRID_H - 3;
  for (let x = 1; x < GRID_W - 1; x++) {
    bottomRowOil += sim.get(x, bottomY).o;
    bottomRowWater += sim.get(x, bottomY).w;
  }
  check('底排无油（油密度小，在上层）', bottomRowOil < 1e-6,
    `bottomRowOil=${bottomRowOil}`);
  check('底排被水完全充满', approx(bottomRowWater, GRID_W - 2, 1e-6),
    `bottomRowWater=${bottomRowWater}`);
  // 36 水 = 底排 19 格 + 界面行 17 格；界面行解析解：每格 17/19 水、2/19 油
  const c = sim.get(5, interfaceY);
  check('界面行为均匀混合行（解析解 17/19 水 + 2/19 油）',
    approx(c.w, 17 / 19, 1e-6) && approx(c.o, 2 / 19, 1e-6),
    `w=${c.w} o=${c.o}`);
  // 油区（界面行以上）不应出现水
  let waterInOilZone = 0;
  for (let y = 1; y <= interfaceY - 1; y++) {
    for (let x = 1; x < GRID_W - 1; x++) waterInOilZone += sim.get(x, y).w;
  }
  check('油区不含水', waterInOilZone < 1e-6, `waterInOilZone=${waterInOilZone}`);
  assertInvariants(sim, 'U形管实验结束');
}

// ---------- 3. 狭缝：水只能穿过隔墙底部的两格狭缝 ----------
console.log('\n[3] 狭缝流动');
{
  const sim = presetById('slit');
  const before = sim.totals();
  check('狭缝格 (10,13)/(10,14) 不是墙',
    !sim.get(10, 13).wall && !sim.get(10, 14).wall);
  check('隔墙其余位置仍是墙', sim.get(10, 5).wall && sim.get(10, 12).wall);
  runN(sim, 4000);
  const after = sim.totals();
  check('狭缝场景水量守恒', approx(after.w, before.w));
  check('狭缝场景油量守恒', approx(after.o, before.o));
  // 水穿过狭缝到达右室底部
  const rightBottomWater =
    sim.get(15, GRID_H - 2).w + sim.get(18, GRID_H - 2).w;
  check('水经狭缝流入右室底部', rightBottomWater > 1.5,
    `rightBottomWater=${rightBottomWater}`);
  check('狭缝格本身带水（通道在工作）',
    sim.get(10, GRID_H - 2).w > 0.5 && sim.get(10, GRID_H - 3).w > 0.5);
  assertInvariants(sim, '狭缝实验结束');
}

// ---------- 4. 排水口账本：排出量 + 余量 = 初始量，累计变化逐口可查 ----------
console.log('\n[4] 排水口累计账本');
{
  const sim = presetById('drain');
  const before = sim.totals();
  const port = sim.ports.get(sim.idx(10, 14))!;
  check('排水口初始为关闭状态', port.open === false);
  runN(sim, 200);
  check('关闭时不排液', port.wOut === 0 && port.oOut === 0);

  port.open = true;
  runN(sim, 1500);
  const after = sim.totals();
  check('水账本闭合：初始 = 当前 + 累计排出',
    approx(before.w, after.w + port.wOut));
  check('油账本闭合：初始 = 当前 + 累计排出',
    approx(before.o, after.o + port.oOut));
  check('排水口所在格已抽空',
    sim.get(10, 14).w === 0 && sim.get(10, 14).o === 0);

  // 注入也入账：在另一个口上加液
  const p2 = sim.togglePort(3, 2)!;
  const added = sim.addLiquid(3, 2, 'w', 0.6);
  check('口上注入计入 wIn 账本', approx(p2.wIn, added) && approx(added, 0.6));
  const net = sim.netPortFlow();
  const t = sim.totals();
  check('全局守恒式成立：初始 + 净注入 = 当前',
    approx(before.w + net.w, t.w) && approx(before.o + net.o, t.o));
  assertInvariants(sim, '排水实验结束');
}

// ---------- 5. 确定性：同样初始状态，任何步数序列结果完全一致 ----------
console.log('\n[5] 更新顺序确定性');
{
  const a = presetById('utube');
  const b = presetById('utube');
  for (let y = 1; y < GRID_H - 1; y++) {
    a.setWall(10, y, false);
    b.setWall(10, y, false);
  }
  // a 连续跑 1000 步；b 分三段跑，中间穿插快照恢复
  runN(a, 1000);
  runN(b, 400);
  const snap = b.snapshot();
  runN(b, 350);
  b.restore(snap); // 回滚后重跑，结果应与不回滚一致
  runN(b, 600);
  let same = true;
  for (let i = 0; i < a.cells.length; i++) {
    if (!approx(a.cells[i].w, b.cells[i].w, 1e-12) ||
        !approx(a.cells[i].o, b.cells[i].o, 1e-12)) {
      same = false;
      break;
    }
  }
  check('同一步数下两条运行路径状态逐格相同', same);
  check('步数计数一致', a.step === b.step && b.step === 1000);
}

// ---------- 6. 渲染频率无关：引擎本身不含时钟，分块推进 == 一次推进 ----------
console.log('\n[6] 绘制频率不影响同一步数结果');
{
  const a = presetById('slit');
  const b = presetById('slit');
  // 模拟 60fps 连续帧每帧 2 步
  for (let frame = 0; frame < 300; frame++) {
    a.advance();
    a.advance();
  }
  // 模拟 20fps 卡顿帧每帧 6 步（总步数相同 = 600）
  for (let frame = 0; frame < 100; frame++) {
    for (let k = 0; k < 6; k++) b.advance();
  }
  let same = true;
  for (let i = 0; i < a.cells.length; i++) {
    if (!approx(a.cells[i].w, b.cells[i].w, 1e-12) ||
        !approx(a.cells[i].o, b.cells[i].o, 1e-12)) {
      same = false;
      break;
    }
  }
  check('不同“帧率”跑满 600 步后状态完全相同', same);
}

// ---------- 7. 竖直分层规则的小尺度直接验证 ----------
console.log('\n[7] 竖直密度分层（单列两格，排除水平边干扰）');
{
  const sim = new Simulation(1, 2);
  // (0,0) 上 / (0,1) 下：初始是不稳定态（下格油多水少）
  sim.setLiquid(0, 0, 0.9, 0.1);
  sim.setLiquid(0, 1, 0.1, 0.9);
  const tw = 1.0;
  const to = 1.0;
  runN(sim, 200);
  const upper = sim.get(0, 0);
  const lower = sim.get(0, 1);
  check('两格水总量守恒', approx(upper.w + lower.w, tw));
  check('两格油总量守恒', approx(upper.o + lower.o, to));
  check('下格优先装满水（w≈1）', approx(lower.w, 1, 1e-6), `lower.w=${lower.w}`);
  check('下格容纳不下的油留到上格（上格 o≈1）', approx(upper.o, 1, 1e-6),
    `upper.o=${upper.o}`);
  check('每格 w+o 不超过容量 1',
    upper.w + upper.o <= CELL_CAPACITY + 1e-9 &&
    lower.w + lower.o <= CELL_CAPACITY + 1e-9);
}

// ---------- 汇总 ----------
console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) {
  console.error('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('全部验证通过 ✅');
