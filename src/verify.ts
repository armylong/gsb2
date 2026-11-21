// verify.ts — 无头验证：在 Node 中跑完整偏移管线并断言关键性质。
// 运行：npm run verify

import {
  Vec, add, mul, rightNormal, leftNormal, signedArea, sampleSpline, cleanOffset, raySegT,
  Intersection,
} from "./geom.js";
import { Node, toSegs, circleNodes, hourglassNodes } from "./presets.js";

declare const process: { exit(code: number): void };

let failures = 0;
function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  if (!cond) failures++;
}

interface Run {
  loops: Vec[][];
  ints: Intersection[];
  origPts: Vec[];
  samples: ReturnType<typeof sampleSpline>;
  orient: number;
}

function run(nodes: Node[], d: number, tol: number): Run {
  const segs = toSegs(nodes);
  const samples = sampleSpline(segs, tol);
  const origPts = samples.map((s) => s.p);
  const orient = Math.sign(signedArea(origPts)) || 1;
  const raw = samples.map((s) =>
    add(s.p, mul(orient > 0 ? rightNormal(s.tan) : leftNormal(s.tan), d))
  );
  const r = cleanOffset(raw, origPts, d, tol, orient);
  return { loops: r.loops, ints: r.ints, origPts, samples, orient };
}

function radiusStats(loop: Vec[]): { mean: number; maxErr: number } {
  let sum = 0;
  for (const p of loop) sum += Math.hypot(p.x, p.y);
  const mean = sum / loop.length;
  let maxErr = 0;
  for (const p of loop) maxErr = Math.max(maxErr, Math.abs(Math.hypot(p.x, p.y) - mean));
  return { mean, maxErr };
}

const TOL = 0.1;
const R = 110;

// 1. 圆形外扩 25 → 单环，半径 ≈ 135
{
  const r = run(circleNodes(R), 25, TOL);
  const ok = r.loops.length === 1;
  const st = ok ? radiusStats(r.loops[0]) : { mean: NaN, maxErr: NaN };
  check(
    "圆形外扩 +25",
    ok && Math.abs(st.mean - (R + 25)) < 0.5 && st.maxErr < 0.8,
    `环数=${r.loops.length} 平均半径=${st.mean.toFixed(3)}（期望 135）最大半径误差=${st.maxErr.toFixed(3)}`
  );
}

// 2. 圆形内缩 25 → 单环，半径 ≈ 85
{
  const r = run(circleNodes(R), -25, TOL);
  const ok = r.loops.length === 1;
  const st = ok ? radiusStats(r.loops[0]) : { mean: NaN, maxErr: NaN };
  check(
    "圆形内缩 -25",
    ok && Math.abs(st.mean - (R - 25)) < 0.5 && st.maxErr < 0.8,
    `环数=${r.loops.length} 平均半径=${st.mean.toFixed(3)}（期望 85）最大半径误差=${st.maxErr.toFixed(3)}`
  );
}

// 3. 圆形内缩超过半径 → 真实的空结果
{
  const r = run(circleNodes(R), -300, TOL);
  check("圆形内缩 -300（超过半径）", r.loops.length === 0, `环数=${r.loops.length}（期望 0，空结果）`);
}

// 4. 窄腰内缩 50（腰部半宽 40）→ 自交并分裂为 2 条有效轮廓
{
  const r = run(hourglassNodes(), -50, TOL);
  check(
    "窄腰内缩 -50（腰部分裂）",
    r.loops.length === 2 && r.ints.length > 0,
    `环数=${r.loops.length}（期望 2）自交点=${r.ints.length}（期望 >0）`
  );
}

// 5. 窄腰内缩 400 → 全部消失，空结果
{
  const r = run(hourglassNodes(), -400, TOL);
  check("窄腰内缩 -400", r.loops.length === 0, `环数=${r.loops.length}（期望 0，空结果）`);
}

// 6. 窄腰外扩 40：腰部是凹口（曲率半径 ≈11 < 40），外扩填凹产生自交，清理后应为单环
{
  const r = run(hourglassNodes(), 40, TOL);
  check(
    "窄腰外扩 +40（凹口自交已清理）",
    r.loops.length === 1 && r.ints.length > 0,
    `环数=${r.loops.length}（期望 1）自交点=${r.ints.length}（期望 >0）`
  );
}

// 6b. 窄腰外扩 5（小于凹口曲率半径）→ 单环，无自交
{
  const r = run(hourglassNodes(), 5, TOL);
  check(
    "窄腰外扩 +5",
    r.loops.length === 1 && r.ints.length === 0,
    `环数=${r.loops.length}（期望 1）自交点=${r.ints.length}（期望 0）`
  );
}

// 7. 抽查法线：圆形外扩 30，36 条法线实测距离都应 ≈ 30
{
  const d = 30;
  const r = run(circleNodes(R), d, TOL);
  let maxDev = 0;
  let measured = 0;
  if (r.loops.length === 1) {
    const loop = r.loops[0];
    for (let k = 0; k < 36; k++) {
      const s = r.samples[Math.floor((k * r.samples.length) / 36)];
      const n = r.orient > 0 ? rightNormal(s.tan) : leftNormal(s.tan);
      let best: number | null = null;
      for (let i = 0; i < loop.length; i++) {
        const t = raySegT(s.p, n, loop[i], loop[(i + 1) % loop.length]);
        if (t !== null && t > 1e-6 && (best === null || t < best)) best = t;
      }
      if (best !== null) {
        measured++;
        maxDev = Math.max(maxDev, Math.abs(best - d));
      }
    }
  }
  check(
    "法线距离抽查（36 条）",
    measured === 36 && maxDev < 0.8,
    `命中=${measured}/36 最大偏差=${maxDev.toFixed(3)} px（期望 < 0.8）`
  );
}

console.log(failures === 0 ? "\n全部通过 ✔" : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
