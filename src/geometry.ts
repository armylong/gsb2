// 陶盘几何工具: 全部角度以弧度计, 0 在屏幕右侧 (局部坐标 +x), 顺盘向为正
// 局部坐标原点在盘心, y 轴向下, 因此 canvas 中角度正向为顺时针

export const TAU = Math.PI * 2;

export interface LocalPoint {
  x: number;
  y: number;
}

/** 把任意角度规范到 [0, 2π) */
export function normalizeAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** 线性插值 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 数值夹取 */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 局部极坐标 -> 局部直角坐标 */
export function polarToXY(r: number, theta: number): LocalPoint {
  return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
}

/**
 * 判断角度 theta 是否落在弧段内。
 * 弧段统一存为 {start, length}, length ∈ (0, 2π), 允许跨过 0/2π。
 * 不做角度插值, 只用归一化后的角度比较, 所以天然支持跨零度弧。
 */
export function angleInArc(
  theta: number,
  start: number,
  length: number,
): boolean {
  const t = normalizeAngle(theta - start);
  return t < length;
}

/**
 * 在两个极坐标采样点之间生成等距子采样点 (含终点, 不含起点)。
 *
 * 关键: 角度差按"最短绕向"处理 (wrap 到 [-π, π])。
 * 一次拖动从 θ=358° 到 θ=2° 时, Δθ 被解释为 +4° 而不是 -356°,
 * 生成的点始终贴着盘边走短弧, 不会出现一条扫过盘心的长线。
 * 半径同理线性插值, 子点不会绕到 r=0 附近。
 */
export function samplePolarSegment(
  from: { r: number; theta: number },
  to: { r: number; theta: number },
  step: number,
): Array<{ r: number; theta: number }> {
  const p0 = polarToXY(from.r, from.theta);
  const p1 = polarToXY(to.r, to.theta);
  const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const count = Math.max(1, Math.ceil(dist / step));

  let dTheta = to.theta - from.theta;
  while (dTheta > Math.PI) dTheta -= TAU;
  while (dTheta < -Math.PI) dTheta += TAU;

  const out: Array<{ r: number; theta: number }> = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    out.push({
      r: lerp(from.r, to.r, t),
      theta: from.theta + dTheta * t,
    });
  }
  return out;
}
