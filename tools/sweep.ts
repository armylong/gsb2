/**
 * 针对性校准：
 *  A. 灯上行到上窗格，要求进入时 |v|<=22
 *  B. 精确平衡的数学条件 g = 2T/m_i 对每个体相同 → 各体 m 必须相等
 *  C. 灯下行穿过下窗格的“刚好过头”：进窗速度略高于阈值（22~35）
 */
import { Engine } from '../src/model.js';
import { LATCH_BANDS } from '../src/geometry.js';

function run(
  weights: Record<'carriage1' | 'lantern' | 'carriage2', number>,
  frames = 60 * 20,
  arm: 'upper' | 'lower' | null = null,
) {
  const eng = new Engine(weights);
  if (arm) eng.toggleLatch(arm);
  let peak = 0;
  const crossAt: Record<string, { v: number; t: number }> = {};
  for (let f = 0; f < frames; f++) {
    eng.step();
    peak = Math.max(peak, Math.abs(eng.v.lantern));
    for (const band of LATCH_BANDS) {
      if (!crossAt[band.id] && eng.h.lantern >= band.hMin && eng.h.lantern <= band.hMax) {
        crossAt[band.id] = { v: Math.abs(eng.v.lantern), t: eng.time };
      }
    }
    if (eng.engagedLatch) break;
  }
  const s = eng.snapshot();
  return { crossAt, peak, final: s.h, engaged: eng.engagedLatch, checks: eng.checks.length };
}

// A. 上行：托架合计 > 灯。先粗看方向与到窗时间
console.log('--- A. 灯上行（h 减小）到上窗格 ---');
for (const mc of [0.9, 1.1, 1.4, 1.8]) {
  const w = { carriage1: mc, lantern: 1.0, carriage2: mc };
  const r = run(w, 60 * 20, 'upper');
  const u = r.crossAt.upper;
  console.log(
    `托架=${mc} 灯=1.0: ${u ? `进上窗 t=${u.t.toFixed(1)}s |v|=${u.v.toFixed(1)}` : '20s内未到'} 终hL=${r.final.lantern.toFixed(0)} 卡住=${r.engaged ?? '无'}`,
  );
}

// C. 刚好过头：让灯只比平衡略重一点，进下窗速度落在 22~40
console.log('\n--- C. 灯下行穿过下窗格，找 |v| 在 22~40 的 ---');
for (const mc of [0.8, 0.9, 1.0, 1.1]) {
  for (const mL of [1.05, 1.1, 1.15, 1.2]) {
    const w = { carriage1: mc, lantern: mL, carriage2: mc };
    const r = run(w, 60 * 20, 'lower');
    const l = r.crossAt.lower;
    if (l && l.v > 18 && l.v < 45) {
      console.log(
        `托架=${mc} 灯=${mL}: 进下窗 t=${l.t.toFixed(1)}s |v|=${l.v.toFixed(1)} 峰值=${r.peak.toFixed(1)} 卡住=${r.engaged ?? '无'}`,
      );
    }
  }
}

// B. 等质量平衡验证
console.log('\n--- B. 等质量 m=1.0 三者，应静止 ---');
const rb = run({ carriage1: 1.0, lantern: 1.0, carriage2: 1.0 }, 240);
console.log('峰值速度', rb.peak.toFixed(6), '终态', JSON.stringify(rb.final));
