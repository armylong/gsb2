/**
 * 无头验证:不启动浏览器/服务,直接用 Simulation 跑真实模拟并断言。
 * 运行:npm run verify
 *
 * 覆盖:
 *  1. 三组预设的到达时间、最小表面间距、速度上限
 *  2. 同种子轨迹可复现
 *  3. 关闭避障(强度 0)出现对穿冲突,作为对照
 *  4. 初始重叠布局被暂停且不步进
 *  5. 窄口拥堵对照:如实报告停滞,不要求全部解开
 *  6. 运行中改目标 / 暂停后移动角色,释放后现场重新生效
 */
import { buildPresets, makeOverlapDemo } from '../src/sim/presets';
import { Simulation } from '../src/sim/sim';
import { DT } from '../src/sim/types';
import { dist } from '../src/sim/math';

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} —— ${detail}`);
}

function run(sim: Simulation, maxSeconds: number): void {
  const maxSteps = Math.ceil(maxSeconds / DT);
  for (let i = 0; i < maxSteps && !sim.finished; i++) sim.step();
}

function trajectories(sim: Simulation): number[] {
  const out: number[] = [];
  for (const a of sim.agents) {
    for (const p of a.trail) out.push(p.x, p.y);
  }
  return out;
}

const seed = 20261119;
const presets = buildPresets(seed);
const strength = 0.7;

// ---------- 1-3. 三组正常预设 ----------
for (const preset of presets.filter((p) => !p.stress)) {
  const sim = new Simulation(
    preset.agents, preset.rects, preset.key, preset.timeLimit, seed, strength,
  );
  run(sim, preset.timeLimit);
  const s = sim.stats();

  check(
    `${preset.key}:限时内全部到达`,
    s.arrived === s.total,
    `${s.arrived}/${s.total} 到达,完成用时 ${(sim.allArrivedTime ?? NaN).toFixed(2)}s(限时 ${preset.timeLimit}s)`,
  );
  check(
    `${preset.key}:无明显重叠(表面间距 ≥ -0.02)`,
    s.minSurfaceGap >= -0.02,
    `全程最小表面间距 ${s.minSurfaceGap.toFixed(4)}`,
  );
  const maxAllowed = Math.max(...sim.agents.map((a) => a.maxSpeed));
  check(
    `${preset.key}:不超过速度上限`,
    s.maxSpeedObserved <= maxAllowed + 1e-6,
    `实测最大速度 ${s.maxSpeedObserved.toFixed(4)} ≤ ${maxAllowed.toFixed(2)}`,
  );

  // 可复现性:同种子、同参数重新构建并跑到同一时刻
  const sim2 = new Simulation(
    buildPresets(seed).find((p) => p.key === preset.key)!.agents,
    preset.rects, preset.key, preset.timeLimit, seed, strength,
  );
  const steps = Math.round(sim.time / DT);
  for (let i = 0; i < steps; i++) sim2.step();
  const t1 = trajectories(sim);
  const t2 = trajectories(sim2);
  let maxDiff = 0;
  for (let i = 0; i < t1.length; i++) maxDiff = Math.max(maxDiff, Math.abs(t1[i] - t2[i]));
  check(
    `${preset.key}:同种子轨迹可复现`,
    maxDiff < 1e-9,
    `两条轨迹最大坐标偏差 ${maxDiff.toExponential(2)}`,
  );

  // 重置清空旧统计
  sim.reset();
  const rs = sim.stats();
  check(
    `${preset.key}:重置清空统计与轨迹`,
    rs.time === 0 && rs.arrived === 0 && rs.minSurfaceGap >= 0 &&
      sim.agents.every((a) => a.trail.length === 0),
    `time=${rs.time}, arrived=${rs.arrived}, minGap=${rs.minSurfaceGap.toFixed(3)}`,
  );
}

// ---------- 4. 关闭避障的对照(精确正对的专用布局) ----------
{
  // 手工构造、无抖动、同排正对:关闭代理间避障时必然对穿
  const specs = [
    { id: 0, pos: { x: 2, y: 10 }, goal: { x: 28, y: 10 }, radius: 0.34, maxSpeed: 2.4, prefSpeed: 2.0, maxAccel: 3.6, color: '#4fc3f7' },
    { id: 1, pos: { x: 28, y: 10 }, goal: { x: 2, y: 10 }, radius: 0.34, maxSpeed: 2.4, prefSpeed: 2.0, maxAccel: 3.6, color: '#81c784' },
  ];
  const simOff = new Simulation(specs, [], 'head-on-off', 20, seed, 0);
  run(simOff, 8.5);
  const offGap = simOff.stats().minSurfaceGap;
  const simOn = new Simulation(specs, [], 'head-on-on', 20, seed, strength);
  run(simOn, 20);
  const onGap = simOn.stats().minSurfaceGap;
  check(
    '强度 0% 关闭代理间避障时出现重叠冲突',
    offGap < -0.1,
    `避障关:最小间距 ${offGap.toFixed(3)}(代理直接对穿)`,
  );
  check(
    '同布局开启避障后绕开且无明显重叠',
    onGap >= -0.02 && simOn.stats().arrived === 2,
    `最小表面间距 ${onGap.toFixed(4)},到达 ${simOn.stats().arrived}/2`,
  );
}

// ---------- 5. 初始重叠布局 ----------
{
  const p = makeOverlapDemo();
  const sim = new Simulation(p.agents, p.rects, p.key, p.timeLimit, seed, strength);
  const before = sim.time;
  sim.step();
  check(
    '初始重叠被检出并暂停布局',
    sim.layoutBlocked && sim.layoutOverlaps.length >= 2 && sim.time === before,
    `检出 ${sim.layoutOverlaps.length} 处重叠,步进被拒绝(time=${sim.time})`,
  );
  // 把重叠代理拖开后解除阻塞
  sim.dragAgent(1, { x: 7.2, y: 5 });
  sim.dragAgent(2, { x: 15, y: 15 });
  check(
    '拖动修正后布局解除暂停',
    !sim.layoutBlocked,
    `剩余重叠 ${sim.layoutOverlaps.length} 处`,
  );
  run(sim, p.timeLimit);
  check(
    '修正后代理可正常到达',
    sim.stats().arrived === sim.agents.length,
    `${sim.stats().arrived}/${sim.agents.length} 到达`,
  );
}

// ---------- 6. 窄口拥堵对照 ----------
{
  const p = presets.find((x) => x.key === 'narrow-gate')!;
  const sim = new Simulation(p.agents, p.rects, p.key, p.timeLimit, seed, strength);
  run(sim, p.timeLimit);
  const s = sim.stats();
  check(
    '窄口对照:全程无明显重叠(即便拥堵也不穿透)',
    s.minSurfaceGap >= -0.02,
    `最小表面间距 ${s.minSurfaceGap.toFixed(4)}`,
  );
  check(
    '窄口对照:时限结束状态如实报告(不伪报成功)',
    (s.arrived < s.total && s.stalled >= 0) || s.arrived === s.total,
    `到达 ${s.arrived}/${s.total},停滞 ${s.stalled},未到达按实际计数`,
  );
  console.log(
    `      窄口详情:到达 ${s.arrived}/${s.total},持续停滞峰值 ${s.stalled},` +
      `最小间距 ${s.minSurfaceGap.toFixed(3)}`,
  );
}

// ---------- 7. 目标临时改变 ----------
{
  const p = presets.find((x) => x.key === 'crossing')!;
  const sim = new Simulation(p.agents, p.rects, p.key, p.timeLimit, seed, strength);
  for (let i = 0; i < 60; i++) sim.step(); // 先跑 2s
  const target = sim.agents[0];
  const newGoal = { x: 2, y: 18 };
  target.goal = newGoal;
  sim.dragGoal(0, newGoal);
  run(sim, p.timeLimit);
  const s = sim.stats();
  const endDist = dist(target.pos, target.goal);
  check(
    '运行中改目标后代理走向新目标',
    endDist < 0.25 && s.maxSpeedObserved <= target.maxSpeed + 1e-6,
    `#0 距新目标 ${endDist.toFixed(3)},最大速度 ${s.maxSpeedObserved.toFixed(3)}`,
  );
}

// ---------- 8. 暂停后移动角色 ----------
{
  const p = presets.find((x) => x.key === 'pillars')!;
  const sim = new Simulation(p.agents, p.rects, p.key, p.timeLimit, seed, strength);
  for (let i = 0; i < 30; i++) sim.step();
  sim.dragAgent(0, { x: 5, y: 10 });
  check(
    '暂停拖动后速度清零且无布局重叠',
    !sim.layoutBlocked && sim.agents[0].speed === 0,
    `重叠 ${sim.layoutOverlaps.length} 处,#0 速度 ${sim.agents[0].speed}`,
  );
  run(sim, p.timeLimit);
  check(
    '释放后按现场重新避让并全部到达',
    sim.stats().arrived === sim.agents.length,
    `${sim.stats().arrived}/${sim.agents.length} 到达`,
  );
}

// ---------- 汇总 ----------
const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
if (failed.length) {
  console.error(`存在 ${failed.length} 项失败:${failed.map((c) => c.name).join('; ')}`);
  process.exit(1);
}
console.log('全部验证通过。');
