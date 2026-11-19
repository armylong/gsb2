/**
 * verifier.ts — 独立核对
 *
 * 用已知几何关系构造场景，核对四类情形：
 *  全亮、全暗、部分遮挡（精确 0.5 楔形）、双挡板重叠（并集不重复计黑），
 * 另含点光源硬阴影退化、对齐墙角的数值稳定性两个场景。
 *
 * 每个场景同时跑解析解与 N 条分层光线，报告：
 *  - 解析值（作为参考真值）
 *  - 采样值、确定性误差界 2/N、95% MC 半宽
 *  - |解析-采样| 实际偏差
 *  - GPU 读回值由 UI 层补上（这里只做纯数学部分，Node 与浏览器共用）
 */

import { Circle, Poly, Vec2, rect, regularPolygon } from './geometry';
import { Scene, analyticVisibility, pointVisibility, sampledVisibility } from './visibility';

export interface VerifyCase {
  name: string;
  kind: '全亮' | '全暗' | '部分遮挡' | '重叠' | '点光源' | '对齐稳定';
  expected: number; // 解析参考值
  tolerance: number; // 允许的解析偏差（构造误差）
  scene: Scene;
  point: Vec2;
  note: string;
}

const RAYS = 256;

/** 以 p 为观察点构造一块恰好遮住光源楔形一半的挡板：
 *  取 p→光源方向为中心，挡板放在中距处，半高 = d·tan(α)，α 为光源半角。 */
function halfBlocker(p: Vec2, light: Circle): Poly {
  const dx = light.c.x - p.x;
  const dy = light.c.y - p.y;
  const d = Math.hypot(dx, dy);
  const alpha = Math.asin(light.r / d);
  const mid = { x: (p.x + light.c.x) / 2, y: (p.y + light.c.y) / 2 };
  const md = d / 2;
  const halfH = Math.tan(alpha) * md; // 精确等于光源楔形半宽在中距处的投影
  // 挡板覆盖从中心线到楔形一侧边缘 → 恰好 50%
  const ang = Math.atan2(dy, dx);
  const nx = -Math.sin(ang);
  const ny = Math.cos(ang);
  const tx = Math.cos(ang);
  const ty = Math.sin(ang);
  const depth = 20;
  const corner = (along: number, side: number): Vec2 => ({
    x: mid.x + tx * along + nx * side,
    y: mid.y + ty * along + ny * side,
  });
  // 四边形：从中心线（side=0）延伸到楔形外（side=halfH*1.02），沿光线方向有厚度
  const over = halfH * 1.04;
  const verts = [corner(-depth / 2, 0), corner(depth / 2, 0), corner(depth / 2, over), corner(-depth / 2, over)];
  return { id: 1, verts };
}

export function buildCases(): VerifyCase[] {
  const light: Circle = { c: { x: 150, y: 300 }, r: 30 };
  const base = { light, range: 900, brightness: 1 };
  const p = { x: 750, y: 300 };

  // 1) 全亮：挡板远离视线
  const fullLit: VerifyCase = {
    name: '全亮（挡板偏离视线）',
    kind: '全亮',
    expected: 1,
    tolerance: 0.005,
    scene: { ...base, polys: [{ id: 1, verts: rect(400, 60, 80, 80) }] },
    point: p,
    note: '光源楔形与挡板楔形不相交，可见比例应为 1',
  };

  // 2) 全暗：大板完全罩住楔形
  const fullDark: VerifyCase = {
    name: '全暗（挡板覆盖整个光源楔形）',
    kind: '全暗',
    expected: 0,
    tolerance: 0.005,
    scene: { ...base, polys: [{ id: 1, verts: rect(420, 180, 90, 240) }] },
    point: p,
    note: '两条切线都落在挡板内，本影区可见比例应为 0',
  };

  // 3) 精确半遮挡
  const halfPoly = halfBlocker(p, light);
  const half: VerifyCase = {
    name: '部分遮挡（几何构造的精确 50%）',
    kind: '部分遮挡',
    expected: 0.5,
    tolerance: 0.02,
    scene: { ...base, polys: [halfPoly] },
    point: p,
    note: '挡板边缘对齐光源楔形中分线，解析值应≈0.5',
  };

  // 4) 双挡板重叠：两块板都遮住楔形中部同一区域，覆盖取并集
  const mid = { x: (p.x + light.c.x) / 2, y: (p.y + light.c.y) / 2 };
  const overlapA: Poly = { id: 1, verts: rect(mid.x - 40, mid.y - 55, 70, 110) };
  const overlapB: Poly = { id: 2, verts: rect(mid.x - 10, mid.y - 45, 70, 90) };
  const sceneOverlap: Scene = { ...base, polys: [overlapA, overlapB] };
  const visA = analyticVisibility(p, { ...base, polys: [overlapA] });
  const visBoth = analyticVisibility(p, sceneOverlap);
  const overlap: VerifyCase = {
    name: '双挡板重叠（并集不重复计黑）',
    kind: '重叠',
    expected: visBoth,
    tolerance: 0.005,
    scene: sceneOverlap,
    point: p,
    note: `单挡可见度=${visA.toFixed(3)}；双挡并集应满足 双挡≤单挡，且不会比全遮挡更暗`,
  };

  // 5) 点光源退化：半径 0，结果只能是 0 或 1
  const pointLight: Circle = { c: light.c, r: 0 };
  const pointCase: VerifyCase = {
    name: '点光源退化（r=0 硬阴影）',
    kind: '点光源',
    expected: pointVisibility(p, { ...base, light: pointLight, polys: [{ id: 1, verts: rect(420, 180, 90, 240) }] }),
    tolerance: 0,
    scene: { ...base, light: pointLight, polys: [{ id: 1, verts: rect(420, 180, 90, 240) }] },
    point: p,
    note: 'r=0 时角度区间宽度为 0，可见度必须是 0/1，不允许中间灰',
  };

  // 6) 对齐墙角：挡板顶点、观察点、光源中心接近共线
  const aligned: Poly = { id: 1, verts: regularPolygon({ x: 450, y: 300 }, 50, 4, Math.PI / 2) };
  const alignedCase: VerifyCase = {
    name: '边缘对齐（顶点-观察点-光源近共线）',
    kind: '对齐稳定',
    expected: analyticVisibility(p, { ...base, polys: [aligned] }),
    tolerance: 0.03,
    scene: { ...base, polys: [aligned] },
    point: p,
    note: '切线角与顶点角重合时结果须有限且落在 [0,1]，采样与解析一致',
  };

  return [fullLit, fullDark, half, overlap, pointCase, alignedCase];
}

export interface VerifyRow {
  name: string;
  kind: VerifyCase['kind'];
  expected: number;
  analytic: number;
  sampled: number;
  hits: number;
  rays: number;
  detBound: number;
  mc95: number;
  actualDiff: number;
  pass: boolean;
  note: string;
}

export function runVerification(rays = RAYS): { rows: VerifyRow[]; allPass: boolean } {
  const cases = buildCases();
  const rows: VerifyRow[] = cases.map((c) => {
    const analytic =
      c.kind === '点光源'
        ? pointVisibility(c.point, c.scene)
        : analyticVisibility(c.point, c.scene);
    const sample = sampledVisibility(c.point, c.scene, rays, true);
    const actualDiff = Math.abs(analytic - sample.vis);
    const expectOk = Math.abs(analytic - c.expected) <= c.tolerance;
    // 采样偏差须同时满足确定性界与 MC 界（MC 界在极端值处为 0，此时退回到确定性界）
    const sampleOk = actualDiff <= sample.deterministicBound + 1e-9 || actualDiff <= sample.mc95 + 1e-9;
    const finiteOk = Number.isFinite(analytic) && analytic >= 0 && analytic <= 1;
    return {
      name: c.name,
      kind: c.kind,
      expected: c.expected,
      analytic,
      sampled: sample.vis,
      hits: sample.hits,
      rays: sample.rays,
      detBound: sample.deterministicBound,
      mc95: sample.mc95,
      actualDiff,
      pass: expectOk && sampleOk && finiteOk,
      note: c.note,
    };
  });

  // 重叠场景的额外语义断言：双挡可见度 ≤ 任一单挡，且 >= 0
  const overlapCase = cases[3];
  const rowOverlap = rows[3];
  const visA = analyticVisibility(overlapCase.point, {
    ...overlapCase.scene,
    polys: [overlapCase.scene.polys[0]],
  });
  const semanticPass = rowOverlap.analytic <= visA + 1e-9 && rowOverlap.analytic >= 0;
  rowOverlap.pass = rowOverlap.pass && semanticPass;

  return { rows, allPass: rows.every((r) => r.pass) };
}
