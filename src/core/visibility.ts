/**
 * visibility.ts — 接收点对面积光源的可见比例
 *
 * 两条独立路径，互为核对：
 *  - analyticVisibility：角度楔形并集解析解，逐挡板取切线角度、求并集、
 *    与光源角度区间求交，得到被挡比例。多挡板按角度并集合成，重叠不重复计黑。
 *  - sampledVisibility：在光源角度区间内做分层（stratified）光线检查，
 *    每条光线用线段-凸多边形求交，给出蒙特卡洛估计与误差范围。
 * 两者使用同一个光源区间定义与同一套凸多边形几何，结果应在采样误差内一致。
 */

import {
  Circle,
  EPS,
  Interval,
  Poly,
  TAU,
  Vec2,
  coveredLength,
  cutToCircle,
  lightWedge,
  mergeIntervals,
  norm2pi,
  segmentHitsConvex,
  tangentWedge,
  wrapPi,
} from './geometry';

export interface Scene {
  light: Circle;
  polys: Poly[];
  /** 光源有效照射距离（衰减半径） */
  range: number;
  /** 亮度系数 0..2 */
  brightness: number;
}

/**
 * 解析可见度（面积光源）。
 * 返回 0..1：1 表示光源完全可见，0 表示全遮挡（本影）。
 * 接收点位于任何挡板内部时按 0 处理（挡板本身不被照亮）。
 */
export function analyticVisibility(p: Vec2, scene: Scene): number {
  for (const poly of scene.polys) {
    // 与 tangentWedge 的外部前提保持一致：内部点直接全挡
    if (pointInside(p, poly)) return 0;
  }
  const lw = lightWedge(p, scene.light);
  if (lw === null) return 1; // P 在光源圆盘内部

  // r=0 退化为点光源：角度区间宽度为 0，可见度必须是硬 0/1
  if (scene.light.r <= EPS) return pointVisibility(p, scene);

  const lightSegs = cutToCircle(lw.mean, lw.half);
  const blocked: Interval[] = [];
  for (const poly of scene.polys) {
    const wedge = tangentWedge(p, poly);
    // 把楔形转换为相对于光源中心方向的偏移量，判断是否与光源区间相交
    const delta = wrapPi(wedge.mean - lw.mean);
    // 光源半宽 < π/2；楔形半宽 ≤ π/2。两者相交当且仅当 |delta| < half 之和
    if (Math.abs(delta) > wedge.half + lw.half + EPS) continue;
    for (const seg of cutToCircle(lw.mean + delta, wedge.half)) blocked.push(seg);
  }
  const union = mergeIntervals(blocked);
  const lightTotal = lightSegs.reduce((acc, L) => acc + (L.e - L.s), 0);
  const covered = coveredLength(lightSegs, union);
  return Math.max(0, Math.min(1, 1 - covered / lightTotal));
}

/** 点光源解析可见度：任一档板挡住视线即 0，否则 1 */
export function pointVisibility(p: Vec2, scene: Scene): number {
  for (const poly of scene.polys) {
    if (pointInside(p, poly)) return 0;
    if (segmentHitsConvex(p, scene.light.c, poly)) return 0;
  }
  return 1;
}

function pointInside(p: Vec2, poly: Poly): boolean {
  const n = poly.verts.length;
  for (let i = 0; i < n; i++) {
    const a = poly.verts[i];
    const b = poly.verts[(i + 1) % n];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross < -EPS) return false;
  }
  return true;
}

export interface SampleResult {
  /** 可见比例估计（命中光线数 / 总光线数） */
  vis: number;
  rays: number;
  hits: number;
  /** 分层确定性误差上界：每个层内可见度可能整体翻转，2/N */
  deterministicBound: number;
  /** 二项分布 95% 置信半宽（Wald，近似） */
  mc95: number;
}

/**
 * 分层光线采样核对。
 * 在光源对 P 张开的角度区间内均匀分 N 层，每层一条光线（带 jitter），
 * 沿该方向与光源圆盘相交得到光线终点，再对所有挡板做线段求交。
 * jitter 用确定性的黄金角序列，保证测试可复现。
 */
export function sampledVisibility(p: Vec2, scene: Scene, nRays = 64, jitter = true): SampleResult {
  const lw = lightWedge(p, scene.light);
  if (lw === null) {
    return { vis: 1, rays: nRays, hits: nRays, deterministicBound: 0, mc95: 0 };
  }
  if (scene.polys.some((poly) => pointInside(p, poly))) {
    return { vis: 0, rays: nRays, hits: 0, deterministicBound: 0, mc95: 0 };
  }

  const golden = 0.6180339887498949;
  let hits = 0;
  const a0 = lw.mean - lw.half;
  const span = lw.half * 2;
  const d = sub2(scene.light.c, p);
  const dd = Math.hypot(d.x, d.y);

  for (let i = 0; i < nRays; i++) {
    const frac = jitter ? (i + ((i * golden) % 1)) / nRays : (i + 0.5) / nRays;
    const ang = a0 + frac * span;
    const dir = { x: Math.cos(ang), y: Math.sin(ang) };
    // 求射线与光源圆盘的交点距离 t（取进入圆盘的近交点）
    const t = rayCircleT(d, dd, dir, scene.light.r);
    const end = { x: p.x + dir.x * t, y: p.y + dir.y * t };
    let blocked = false;
    for (const poly of scene.polys) {
      if (segmentHitsConvex(p, end, poly)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) hits++;
  }

  const vis = hits / nRays;
  const mc95 = 1.96 * Math.sqrt((vis * (1 - vis)) / nRays);
  return {
    vis,
    rays: nRays,
    hits,
    deterministicBound: 2 / nRays,
    mc95,
  };
}

/** 射线 p + t·dir 与圆盘（圆心相对 p 的向量为 d，距离 dd，半径 r）的近交点 t */
function rayCircleT(d: Vec2, dd: number, dir: Vec2, r: number): number {
  const proj = d.x * dir.x + d.y * dir.y;
  const disc = r * r - (dd * dd - proj * proj);
  const root = Math.sqrt(Math.max(0, disc));
  return proj - root;
}

function sub2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

/**
 * 距离衰减：0..1 的平滑系数。
 * 距离 ≤ 0.94·range 时全亮，之后 smoothstep 过渡，≥ range 时为 0，
 * 超出照射距离后统一只剩环境光（在渲染层处理）。
 */
export function rangeFactor(p: Vec2, scene: Scene): number {
  const d = Math.hypot(p.x - scene.light.c.x, p.y - scene.light.c.y);
  const start = scene.range * 0.94;
  if (d <= start) return 1;
  if (d >= scene.range) return 0;
  const t = (d - start) / (scene.range - start);
  return 1 - t * t * (3 - 2 * t);
}

/** 重新导出便于渲染层与测试复用 */
export { norm2pi, TAU };
