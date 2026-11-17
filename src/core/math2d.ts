/** 二维向量工具：全部为纯函数，不依赖任何渲染库 */

export interface Vec2 {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec2 => ({ x, y });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/** 二维叉积（标量）：a 到 b 的有向 sin * |a||b| */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export const length = (a: Vec2): number => Math.hypot(a.x, a.y);

export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export const normalize = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  if (l < 1e-12) return { x: 0, y: 0 };
  return { x: a.x / l, y: a.y / l };
};

/** 单位切向量 t 对应的左侧单位法向量（t 逆时针转 90°） */
export const leftNormal = (t: Vec2): Vec2 => ({ x: -t.y, y: t.x });

export const lerp = (a: Vec2, b: Vec2, s: number): Vec2 => ({
  x: a.x + (b.x - a.x) * s,
  y: a.y + (b.y - a.y) * s,
});

/** 角度（弧度，[-π, π]），at 为圆心 */
export const angleOf = (p: Vec2, at: Vec2): number =>
  Math.atan2(p.y - at.y, p.x - at.x);

export const nearlyEqual = (a: number, b: number, eps = 1e-7): boolean =>
  Math.abs(a - b) <= eps;

/** 把角度差规范到 (-π, π] */
export const wrapAngle = (a: number): number => {
  let r = a % (Math.PI * 2);
  if (r <= -Math.PI) r += Math.PI * 2;
  if (r > Math.PI) r -= Math.PI * 2;
  return r;
};

/**
 * 从角度 a0 沿给定方向（dir=1 逆时针 / -1 顺时针）走到 a1 的角度序列，
 * 均匀分成 segments 段。返回的点包含两端。
 */
export const arcAngles = (a0: number, a1: number, dir: 1 | -1, segments: number): number[] => {
  const delta = wrapAngle(a1 - a0);
  // 让 delta 的符号与 dir 一致
  const signed = dir === 1 ? (delta >= 0 ? delta : delta + Math.PI * 2)
    : (delta <= 0 ? delta : delta - Math.PI * 2);
  const out: number[] = [];
  for (let i = 0; i <= segments; i++) out.push(a0 + (signed * i) / segments);
  return out;
};

/** 两条参数直线 P + t*d1, Q + u*d2 的交点参数 t；平行时返回 null */
export const rayIntersect = (P: Vec2, d1: Vec2, Q: Vec2, d2: Vec2): { t: number; u: number } | null => {
  const denom = cross(d1, d2);
  if (Math.abs(denom) < 1e-12) return null;
  const diff = sub(Q, P);
  const t = cross(diff, d2) / denom;
  const u = cross(diff, d1) / denom;
  return { t, u };
};
