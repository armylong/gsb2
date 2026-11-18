// 无头验证脚本：npm run verify
// 验证：1) 平地静止承重与压缩趋势 2) 阻尼变化后的振幅衰减
//       3) 越过凸起的行程范围 4) 不同显示帧率下同一模拟时间的一致性
//       5) 重置确定性
import {
  createSim, step, setDrive, getCompression, wheelInContact, getSpeed,
  staticCompression, FIXED_DT, TRAVEL, GRAVITY,
  type SimParams,
} from '../src/sim';

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  [${detail}]`);
  if (!ok) failures++;
}

// 记录左轮压缩曲线的辅助
function runRecord(sim: ReturnType<typeof createSim>, seconds: number): { t: number[]; c: number[] } {
  const t: number[] = [], c: number[] = [];
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    step(sim);
    t.push(sim.time);
    c.push(getCompression(sim, 0));
  }
  return { t, c };
}

function amplitude(t: number[], c: number[], ref: number, t0: number, t1: number): number {
  let a = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] >= t0 && t[i] <= t1) a = Math.max(a, Math.abs(c[i] - ref));
  }
  return a;
}

// ---------- 测试 1：平地静止时两轮承重与压缩趋势 ----------
console.log('\n[1] 平地落车：静止承重与压缩趋势');
{
  const params: SimParams = { stiffness: 30000, damping: 2600, chassisMass: 800 };
  const sim = createSim(params, 'flat');
  const { t, c } = runRecord(sim, 6);
  const cL = getCompression(sim, 0);
  const cR = getCompression(sim, 1);
  const theory = staticCompression(params); // m_s*g/k = 0.1307m
  const avg = (cL + cR) / 2;

  check('两轮均接地', wheelInContact(sim, 0) && wheelInContact(sim, 1),
    `L=${wheelInContact(sim, 0)} R=${wheelInContact(sim, 1)}`);
  check('两轮均承重（压缩>0）', cL > 0 && cR > 0,
    `cL=${(cL * 1000).toFixed(1)}mm cR=${(cR * 1000).toFixed(1)}mm`);
  check('两轮压缩接近（<10%）', Math.abs(cL - cR) / avg < 0.10,
    `偏差=${(Math.abs(cL - cR) / avg * 100).toFixed(2)}%`);
  check('压缩收敛到理论静压值（±15%）', Math.abs(avg - theory) / theory < 0.15,
    `实测=${(avg * 1000).toFixed(1)}mm 理论=${(theory * 1000).toFixed(1)}mm`);
  const early = amplitude(t, c, theory, 0.4, 1.0);
  const late = amplitude(t, c, theory, 4.5, 5.5);
  check('振荡随时间衰减（趋势）', late < early * 0.5,
    `早期振幅=${(early * 1000).toFixed(1)}mm 后期=${(late * 1000).toFixed(1)}mm`);
}

// ---------- 测试 2：阻尼变化后的振幅衰减 ----------
console.log('\n[2] 阻尼对振幅衰减的影响（同一落车）');
{
  const k = 30000, m = 800;
  const ms = m / 2;
  const zetaOf = (c: number) => c / (2 * Math.sqrt(k * ms));
  const mk = (c: number) => createSim({ stiffness: k, damping: c, chassisMass: m }, 'flat');
  const theory = (ms * GRAVITY) / k;

  const lowC = zetaOf(0) * 0 + 0.1 * 2 * Math.sqrt(k * ms);   // ζ≈0.1
  const highC = 0.9 * 2 * Math.sqrt(k * ms);                  // ζ≈0.9

  const low = runRecord(mk(lowC), 3);
  const high = runRecord(mk(highC), 3);

  // 低阻尼应有可见振荡：穿越静压值次数 >= 3
  let crossings = 0;
  for (let i = 1; i < low.t.length && low.t[i] < 2.5; i++) {
    if ((low.c[i - 1] - theory) * (low.c[i] - theory) < 0) crossings++;
  }
  const ampLow = amplitude(low.t, low.c, theory, 1.2, 2.2);
  const ampHigh = amplitude(high.t, high.c, theory, 1.2, 2.2);

  check('低阻尼出现可观察振荡（过零≥3次）', crossings >= 3,
    `ζ=${zetaOf(lowC).toFixed(2)} 过零=${crossings}次`);
  check('增大阻尼后振幅显著减小（<40%）', ampHigh < ampLow * 0.4,
    `低阻尼振幅=${(ampLow * 1000).toFixed(1)}mm 高阻尼=${(ampHigh * 1000).toFixed(1)}mm (ζ ${zetaOf(lowC).toFixed(2)}→${zetaOf(highC).toFixed(2)})`);
}

// ---------- 测试 3：越过凸起时行程不超限、不脱开 ----------
console.log('\n[3] 驱动越过单个凸起：行程范围');
{
  const params: SimParams = { stiffness: 30000, damping: 2600, chassisMass: 800 };
  const sim = createSim(params, 'bump');
  setDrive(sim, 'forward');
  let maxC = -Infinity, minC = Infinity;
  let maxSpeed = 0;
  const steps = Math.round(6 / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    step(sim);
    for (const w of [0, 1] as const) {
      const c = getCompression(sim, w);
      maxC = Math.max(maxC, c);
      minC = Math.min(minC, c);
    }
    maxSpeed = Math.max(maxSpeed, Math.abs(getSpeed(sim)));
  }
  const x = sim.chassis.getPosition().x;
  check('车辆驶过凸起（x>25m）', x > 25, `x=${x.toFixed(1)}m`);
  check('压缩不超上限', maxC <= TRAVEL + 1e-4,
    `max=${(maxC * 1000).toFixed(1)}mm 上限=${TRAVEL * 1000}mm`);
  check('伸展不超下限', minC >= -TRAVEL - 1e-4,
    `min=${(minC * 1000).toFixed(1)}mm 下限=${-TRAVEL * 1000}mm`);
  check('悬挂确实被压过静压值（有行程使用）', maxC > staticCompression(params) * 1.3,
    `max=${(maxC * 1000).toFixed(1)}mm 静压=${(staticCompression(params) * 1000).toFixed(1)}mm`);
  check('速度限制在样例范围内', maxSpeed <= 20.5, `maxSpeed=${(maxSpeed * 3.6).toFixed(1)}km/h`);
}

// ---------- 测试 3b：软弹簧重车身，硬止挡限制行程 ----------
console.log('\n[3b] 行程硬止挡（软弹簧+重车身，必然触底）');
{
  // 静压需求 0.49m >> 行程 0.25m，悬挂必然压在止挡上
  const params: SimParams = { stiffness: 10000, damping: 2600, chassisMass: 2000 };
  const sim = createSim(params, 'flat');
  let maxC = -Infinity;
  for (let i = 0; i < Math.round(5 / FIXED_DT); i++) {
    step(sim);
    maxC = Math.max(maxC, getCompression(sim, 0), getCompression(sim, 1));
  }
  const cL = getCompression(sim, 0);
  const chassisBottom = sim.chassis.getPosition().y - 0.25; // CHASSIS_HH
  check('压缩被钳制在行程内', maxC <= TRAVEL + 1e-4,
    `max=${(maxC * 1000).toFixed(1)}mm 上限=${TRAVEL * 1000}mm`);
  check('静止时压在止挡上（接近上限）', Math.abs(cL - TRAVEL) < 0.02,
    `cL=${(cL * 1000).toFixed(1)}mm`);
  check('车身未陷入地面', chassisBottom > -0.02,
    `车底高度=${chassisBottom.toFixed(3)}m`);
}

// ---------- 测试 4：不同显示帧率下同一模拟时间的一致性 ----------
console.log('\n[4] 帧率无关性（固定步长 + 累加器）');
{
  const params: SimParams = { stiffness: 30000, damping: 2600, chassisMass: 800 };
  // 用不同的“帧时长”模式推进到同一模拟时间 4.0s
  const patterns: { name: string; frames: number[] }[] = [
    { name: '60fps', frames: [1 / 60] },
    { name: '30fps', frames: [1 / 30] },
    { name: '混合(1/30,1/144,1/47)', frames: [1 / 30, 1 / 144, 1 / 47] },
  ];
  const results: { x: number; y: number; cL: number; cR: number }[] = [];
  for (const p of patterns) {
    const sim = createSim(params, 'flat');
    setDrive(sim, 'forward');
    let acc = 0, fi = 0;
    while (sim.time < 4.0 - 1e-9) {
      acc += p.frames[fi++ % p.frames.length];
      while (acc >= FIXED_DT) { step(sim); acc -= FIXED_DT; }
    }
    results.push({
      x: sim.chassis.getPosition().x,
      y: sim.chassis.getPosition().y,
      cL: getCompression(sim, 0),
      cR: getCompression(sim, 1),
    });
    console.log(`    ${p.name}: 步数=${Math.round(sim.time / FIXED_DT)} x=${results[results.length - 1].x.toFixed(6)}`);
  }
  const base = results[0];
  let maxDiff = 0;
  for (const r of results.slice(1)) {
    maxDiff = Math.max(maxDiff, Math.abs(r.x - base.x), Math.abs(r.y - base.y),
      Math.abs(r.cL - base.cL), Math.abs(r.cR - base.cR));
  }
  check('同一模拟时间状态一致（容差 1mm）', maxDiff < 1e-3,
    `最大偏差=${(maxDiff * 1000).toFixed(4)}mm`);
}

// ---------- 测试 5：重置确定性 ----------
console.log('\n[5] 重置确定性（相同参数两次运行）');
{
  const params: SimParams = { stiffness: 45000, damping: 1500, chassisMass: 1200 };
  const run = () => {
    const sim = createSim(params, 'bump');
    setDrive(sim, 'forward');
    for (let i = 0; i < Math.round(3 / FIXED_DT); i++) step(sim);
    return { x: sim.chassis.getPosition().x, y: sim.chassis.getPosition().y, c: getCompression(sim, 0) };
  };
  const a = run(), b = run();
  const diff = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.c - b.c));
  check('两次运行结果完全一致（容差 1e-9）', diff < 1e-9, `偏差=${diff}`);
}

console.log(failures === 0 ? '\n全部验证通过 ✅' : `\n${failures} 项未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);
