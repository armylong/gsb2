/// <reference types="node" />
/**
 * 无头验证脚本 (npm run verify):
 * 复用浏览器同一套模拟核心 ClothSimulation + SimulationDriver,
 * 用虚拟墙钟驱动 30fps / 60fps 两种显示节奏, 在相同初始条件下推进相同模拟时间,
 * 输出固定点偏移、最大边长变化、球内穿入量以及两种帧率的形状差异.
 *
 * 不依赖 three.js / 浏览器, 可在本地 Node 直接运行.
 */
import { ClothSimulation, DEFAULT_TOLERANCES, type ClothMetrics, type Tolerances } from '../src/sim/cloth';
import { SimulationDriver } from '../src/sim/driver';
import { SCENARIOS, getScenario, type Scenario } from '../src/sim/scenarios';

const FIXED_DT = 1 / 120;
const TARGET_SIM_TIME = 4; // 秒

// ---------- 工具 ----------

/** 可重复的伪随机数 (mulberry32), 保证验证结果可复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSim(scenario: Scenario): ClothSimulation {
  const sim = new ClothSimulation(
    structuredClone(scenario.config),
    FIXED_DT,
    { ...scenario.sphere },
  );
  sim.sphereActive = scenario.sphereActive;
  return sim;
}

interface RunResult {
  sim: ClothSimulation;
  frames: number;
  steps: number;
  renderFrames: number;
}

/**
 * 用虚拟墙钟按指定显示节奏驱动指定物理步数.
 * jitter=true 时给每个帧间隔叠加随机抖动并偶发卡顿 (钳制在 MAX_CATCH_UP),
 * 模拟真实浏览器 rAF 的不稳定性. 两种帧率跑相同步数 => 相同模拟时间.
 */
function runWithDisplayFps(
  scenario: Scenario,
  displayFps: 30 | 60,
  stepCount: number,
  jitter: boolean,
  seed: number,
): RunResult {
  const sim = makeSim(scenario);
  const driver = new SimulationDriver(sim, FIXED_DT);
  driver.setDisplayFps(displayFps);
  driver.play();

  const rng = mulberry32(seed + displayFps);
  const nominalInterval = 1 / displayFps;
  let wall = 0;
  let frames = 0;
  let renderFrames = 0;
  let executedSteps = 0;

  while (executedSteps < stepCount) {
    let interval = nominalInterval;
    if (jitter) {
      // ±35% 抖动, 并有 8% 概率出现一次长卡顿 (会被 driver 钳制)
      interval = nominalInterval * (0.65 + rng() * 0.7);
      if (rng() < 0.08) interval += 0.04 + rng() * 0.12;
    }
    wall += interval;
    // 本帧最多还允许执行的物理步数, 防止 30fps 下一帧跨多步越过目标
    const budget = stepCount - executedSteps;
    if (driver.frame(wall, budget)) renderFrames++;
    executedSteps += driver.lastFrameSteps;
    frames++;
    if (frames > 100000) throw new Error('虚拟时钟运行超过保护上限');
  }

  return { sim, frames, steps: executedSteps, renderFrames };
}

function shapeDiff(a: ClothSimulation, b: ClothSimulation): { max: number; rms: number } {
  if (a.particleCount !== b.particleCount) throw new Error('粒子数不一致');
  let max = 0;
  let sumSq = 0;
  for (let i = 0; i < a.pos.length; i++) {
    const d = Math.abs(a.pos[i] - b.pos[i]);
    if (d > max) max = d;
    sumSq += d * d;
  }
  return { max, rms: Math.sqrt(sumSq / a.pos.length) };
}

function compareMetrics(m: ClothMetrics): string {
  return [
    `固定点偏移=${m.pinOffset.toExponential(2)}m`,
    `边长变化率=${(m.maxEdgeStrain * 100).toFixed(2)}%`,
    `最大边长=${m.maxEdgeLength.toFixed(4)}m`,
    `穿入深度=${m.maxPenetration.toExponential(2)}m`,
    `穿入顶点=${m.penetratingCount}`,
  ].join(' · ');
}

// ---------- 各项检查 ----------

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function checkStability(label: string, r: RunResult, tol: Tolerances): Check[] {
  const m = r.sim.metrics();
  const checks: Check[] = [
    {
      name: `${label} 固定点偏移`,
      pass: m.pinOffset <= tol.pinOffset,
      detail: `${m.pinOffset.toExponential(2)} m (允许 ≤ ${tol.pinOffset.toExponential(2)})`,
    },
    {
      name: `${label} 最大边长变化率`,
      pass: m.maxEdgeStrain <= tol.edgeStrain,
      detail: `${(m.maxEdgeStrain * 100).toFixed(2)} % (允许 ≤ ${tol.edgeStrain * 100}%)`,
    },
  ];
  if (r.sim.sphereActive) {
    checks.push({
      name: `${label} 球内穿入深度`,
      pass: m.maxPenetration <= tol.penetration,
      detail: `${m.maxPenetration.toExponential(2)} m, ${m.penetratingCount} 个顶点 (允许 ≤ ${tol.penetration.toExponential(2)})`,
    });
  }
  return checks;
}

function runFpsComparison(jitter: boolean, tol: Tolerances): Check[] {
  const mode = jitter ? '抖动帧 (模拟真实 rAF)' : '均匀帧 (理想节奏)';
  const checks: Check[] = [];
  const stepCount = Math.round(TARGET_SIM_TIME / FIXED_DT);
  console.log(`\n=== 帧率对比: ${mode}, 每路推进 ${stepCount} 个物理步 (= ${TARGET_SIM_TIME}s), 固定步长 1/120s ===`);

  for (const scenario of SCENARIOS) {
    const r60 = runWithDisplayFps(scenario, 60, stepCount, jitter, 1234);
    const r30 = runWithDisplayFps(scenario, 30, stepCount, jitter, 1234);
    const diff = shapeDiff(r60.sim, r30.sim);
    const timeDiff = Math.abs(r60.sim.simTime - r30.sim.simTime);
    const m60 = r60.sim.metrics();
    const m30 = r30.sim.metrics();

    console.log(`\n[${scenario.label}]`);
    console.log(`  60fps: ${r60.frames} 个显示帧 / ${r60.steps} 个物理步, ${compareMetrics(m60)}`);
    console.log(`  30fps: ${r30.frames} 个显示帧 / ${r30.steps} 个物理步, ${compareMetrics(m30)}`);
    console.log(
      `  形状差异: 最大 ${diff.max.toExponential(2)}m, RMS ${diff.rms.toExponential(2)}m, 模拟时间差 ${timeDiff.toExponential(2)}s`,
    );

    checks.push(...checkStability(`[${scenario.label}/60fps]`, r60, tol));
    checks.push(...checkStability(`[${scenario.label}/30fps]`, r30, tol));
    checks.push({
      name: `[${scenario.label}] 30/60 帧最大形状差异`,
      pass: diff.max <= tol.shapeMaxDiff,
      detail: `${diff.max.toExponential(2)} m (允许 ≤ ${tol.shapeMaxDiff} m)`,
    });
    checks.push({
      name: `[${scenario.label}] 30/60 帧 RMS 形状差异`,
      pass: diff.rms <= tol.shapeRmsDiff,
      detail: `${diff.rms.toExponential(2)} m (允许 ≤ ${tol.shapeRmsDiff} m)`,
    });
    checks.push({
      name: `[${scenario.label}] 模拟时间一致`,
      pass: timeDiff <= tol.simTimeDiff,
      detail: `${timeDiff.toExponential(2)} s (允许 ≤ ${tol.simTimeDiff} s)`,
    });
  }
  return checks;
}

/**
 * 移动中的球体: 先自然下垂, 再沿 z 向布推入 (托起), 最后保持.
 * 球心持续位移也必须每步把顶点推出球面, 不允许持续陷在球内.
 */
function runMovingSphereCheck(tol: Tolerances): Check {
  const scenario = getScenario('sphere-lift');
  const sim = makeSim(scenario);
  const totalSteps = Math.round(TARGET_SIM_TIME / FIXED_DT);
  const pushStart = Math.round(1.2 / FIXED_DT);
  const pushEnd = Math.round(3.2 / FIXED_DT);
  const zStart = sim.sphere.z; // -2
  const zEnd = 0.35;
  let worstPenetration = 0;
  let penAtStepEnd = 0;
  let maxContact = 0;

  for (let step = 0; step < totalSteps; step++) {
    if (step >= pushStart && step <= pushEnd) {
      const u = (step - pushStart) / (pushEnd - pushStart);
      sim.sphere.z = zStart + (zEnd - zStart) * u;
      sim.sphere.x = 0.3 * Math.sin(sim.simTime * 0.7);
    }
    sim.step();
    const m = sim.metrics();
    if (m.maxPenetration > worstPenetration) worstPenetration = m.maxPenetration;
    penAtStepEnd = m.maxPenetration;
    // 接触带顶点数 (球面外 3cm 内)
    let contact = 0;
    for (let i = 0; i < sim.particleCount; i++) {
      if (sim.pinned[i]) continue;
      const d = Math.hypot(
        sim.pos[i * 3] - sim.sphere.x,
        sim.pos[i * 3 + 1] - sim.sphere.y,
        sim.pos[i * 3 + 2] - sim.sphere.z,
      );
      if (d - sim.sphere.radius < 0.03) contact++;
    }
    maxContact = Math.max(maxContact, contact);
  }
  const finalM = sim.metrics();
  console.log(`\n=== 移动球体检查 (沿 z 推入布中, ${TARGET_SIM_TIME}s) ===`);
  console.log(
    `  全过程最大穿入=${worstPenetration.toExponential(2)}m, 末帧穿入=${penAtStepEnd.toExponential(2)}m, 峰值接触顶点=${maxContact}`,
  );
  console.log(`  末帧指标: ${compareMetrics(finalM)}`);
  return {
    name: '移动球体不产生持续穿入',
    pass: worstPenetration <= tol.penetration && penAtStepEnd <= tol.penetration && maxContact >= 8,
    detail: `最大穿入 ${worstPenetration.toExponential(2)} m (允许 ≤ ${tol.penetration.toExponential(2)}), 峰值接触 ${maxContact} 个顶点`,
  };
}

/** 暂停期间不允许推进, 恢复后不补跑; 暂停时切换固定点, 锚点保持原位 */
function runPauseAndPinCheck(tol: Tolerances): Check[] {
  const scenario = getScenario('hanging');
  const sim = makeSim(scenario);
  const driver = new SimulationDriver(sim, FIXED_DT);
  const checks: Check[] = [];

  driver.play();
  driver.frame(1 / 60);
  driver.frame(2 / 60);
  const timeBeforePause = sim.simTime;
  driver.pause();

  // 虚拟墙钟走过 10 秒暂停时间
  for (let k = 1; k <= 600; k++) driver.frame(2 / 60 + k / 60);
  const frozen = Math.abs(sim.simTime - timeBeforePause) < 1e-12;
  const snapshot = Float64Array.from(sim.pos);
  checks.push({
    name: '暂停期间模拟完全冻结',
    pass: frozen,
    detail: `暂停前 ${timeBeforePause.toFixed(4)}s, 10s 墙钟后 ${sim.simTime.toFixed(4)}s`,
  });

  // 暂停时把顶边中点也固定; 至少保留 1 个固定点的约束由 UI 保证, 这里验证机制本身
  const midTop = sim.index(0, Math.floor(sim.cols / 2));
  sim.setPinned(midTop, true);
  const anchor = [sim.anchors[midTop * 3], sim.anchors[midTop * 3 + 1], sim.anchors[midTop * 3 + 2]];
  driver.play();
  for (let k = 0; k < 120; k++) driver.frame(10 + k / 60);
  const anchorDrift = Math.hypot(
    sim.pos[midTop * 3] - anchor[0],
    sim.pos[midTop * 3 + 1] - anchor[1],
    sim.pos[midTop * 3 + 2] - anchor[2],
  );
  checks.push({
    name: '暂停时新增固定点后锚点不漂移',
    pass: anchorDrift <= tol.pinOffset,
    detail: `漂移 ${anchorDrift.toExponential(2)} m (允许 ≤ ${tol.pinOffset.toExponential(2)})`,
  });

  // 释放原左上角后它应重新参与运动 (prev 对齐, 无速度突跳)
  const leftTop = 0;
  const before = sim.pos[leftTop * 3 + 1];
  driver.pause();
  sim.setPinned(leftTop, false);
  driver.play();
  for (let k = 0; k < 60; k++) driver.frame(12 + k / 60);
  const moved = Math.abs(sim.pos[leftTop * 3 + 1] - before) > 1e-9;
  checks.push({
    name: '释放固定点后该顶点恢复运动',
    pass: moved,
    detail: `释放点 y ${before.toFixed(4)}m → ${sim.pos[leftTop * 3 + 1].toFixed(4)}m`,
  });

  // 暂停恢复不补跑: 恢复后第一帧墙钟间隔为 1/60, 最多推进 2 个 1/120 步
  const t0 = sim.simTime;
  driver.pause();
  driver.play();
  driver.frame(100); // 内部以该时刻为新起点, 间隔 0
  const firstFrameAdvance = sim.simTime - t0;
  checks.push({
    name: '从暂停恢复不补跑失控运动',
    pass: firstFrameAdvance <= FIXED_DT + 1e-12,
    detail: `恢复首帧推进 ${firstFrameAdvance.toExponential(2)} s (步长 ${FIXED_DT.toFixed(5)}s)`,
  });

  void snapshot;
  return checks;
}

/** 重置必须恢复同一组初始条件 */
function runResetCheck(): Check {
  const scenario = getScenario('sphere-lift');
  const fresh = makeSim(scenario);
  const sim = makeSim(scenario);
  for (let k = 0; k < 300; k++) sim.step();
  sim.reset();
  let same = sim.particleCount === fresh.particleCount && sim.simTime === 0;
  let maxDiff = 0;
  for (let i = 0; i < sim.pos.length && same; i++) {
    const d = Math.abs(sim.pos[i] - fresh.pos[i]);
    if (d > maxDiff) maxDiff = d;
    if (d !== 0) same = false;
  }
  return {
    name: '重置恢复同一组初始条件',
    pass: same,
    detail: `顶点最大差 ${maxDiff.toExponential(2)} m, 模拟时间 ${sim.simTime}s`,
  };
}

/** 调整刚度只改变约束求解, 不允许通过整体缩放布片实现 */
function runNoScalingCheck(): Check {
  const scenario = getScenario('hanging');
  const sim = makeSim(scenario);
  for (let k = 0; k < 120; k++) sim.step();
  const restBefore = Float64Array.from(sim.constraintRest);
  sim.setStiffness(0.2);
  for (let k = 0; k < 120; k++) sim.step();
  let changed = 0;
  for (let i = 0; i < restBefore.length; i++) {
    if (sim.constraintRest[i] !== restBefore[i]) changed++;
  }
  return {
    name: '调抗拉程度不改变静止边长 (无整体缩放)',
    pass: changed === 0,
    detail: `${changed} 条约束静止长度被改动 (应为 0)`,
  };
}

// ---------- 主流程 ----------

function main(): void {
  const tol = DEFAULT_TOLERANCES;
  console.log('低多边形布料模拟 — 无头验证');
  console.log(`固定物理步长 ${FIXED_DT}s (1/120), 每场景推进 ${TARGET_SIM_TIME}s`);
  console.log('允许误差:', JSON.stringify(tol));

  const checks: Check[] = [];
  checks.push(...runFpsComparison(false, tol));
  checks.push(...runFpsComparison(true, tol));
  checks.push(runMovingSphereCheck(tol));
  checks.push(...runPauseAndPinCheck(tol));
  checks.push(runResetCheck());
  checks.push(runNoScalingCheck());

  const failed = checks.filter((c) => !c.pass);
  console.log('\n=== 检查汇总 ===');
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
  if (failed.length > 0) {
    console.error('存在未通过的检查, 请查看上面的 FAIL 行');
    process.exit(1);
  }
}

main();
