/**
 * 最小三维向量工具，纯函数实现，不依赖 three.js —— 验证脚本与渲染层共用同一套数学。
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : { x: 0, y: 0, z: 0 };
};

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

export const cloneVec = (a: Vec3): Vec3 => ({ ...a });

/** 点 p 到线段 (a,b) 的最短距离 */
export const pointSegmentDistance = (p: Vec3, a: Vec3, b: Vec3): number => {
  const ab = sub(b, a);
  const lenSq = dot(ab, ab);
  if (lenSq < 1e-18) return distance(p, a);
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / lenSq));
  return distance(p, lerp(a, b, t));
};

/** 点 p 到折线（点序列首尾相连）的最短距离，返回距离与落在哪条线段上 */
export const pointPolylineDistance = (
  p: Vec3,
  polyline: Vec3[],
): { dist: number; segmentIndex: number; t: number } => {
  let best = Infinity;
  let bestSeg = 0;
  let bestT = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const ab = sub(b, a);
    const lenSq = dot(ab, ab);
    const t = lenSq < 1e-18 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / lenSq));
    const d = distance(p, lerp(a, b, t));
    if (d < best) {
      best = d;
      bestSeg = i;
      bestT = t;
    }
  }
  return { dist: best, segmentIndex: bestSeg, t: bestT };
};
