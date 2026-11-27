// 自带示例图形：全部在「模型坐标」中生成（以原点为中心，单位由调用方缩放）
// 1) 歪叶片：非对称的叶状闭合线
// 2) 不对称轮廓：一边鼓一边收的卵形
// 3) 正圆：偏差图的「无形变」参照
// 4) 平移图形：整体平移的参照（形状不变，只有 c0 改变）

import type { Vec2 } from './geometry';

export type PresetId = 'leaf' | 'lopsided' | 'circle';

function polar(rx: number, ry: number, n: number, perturb: (t: number) => Vec2): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    pts.push({ x: rx * Math.cos(t) + perturb(t).x, y: ry * Math.sin(t) + perturb(t).y });
  }
  return pts;
}

/** 歪叶片：基础椭圆 + 2/3 次谐波，重心偏离原点，两侧弧度明显不同 */
export function makeLeaf(n = 512): Vec2[] {
  return polar(150, 95, n, (t) => ({
    x: 26 * Math.sin(2 * t + 0.7) + 12 * Math.cos(3 * t - 0.4),
    y: 20 * Math.sin(3 * t + 1.3) + 10 * Math.sin(t),
  }));
}

/** 不对称轮廓：径向随角度变化的卵形，右边鼓、左边收 */
export function makeLopsided(n = 512): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const r = 130 * (1 + 0.32 * Math.cos(t) - 0.14 * Math.cos(2 * t + 0.6) + 0.08 * Math.sin(3 * t));
    pts.push({ x: r * Math.cos(t), y: 0.82 * r * Math.sin(t) });
  }
  return pts;
}

/** 正圆参照 */
export function makeCircle(radius = 120, n = 512): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    pts.push({ x: radius * Math.cos(t), y: radius * Math.sin(t) });
  }
  return pts;
}

/** 整体平移：形状原样，只加一个偏移 —— 偏差图应显示「零形变，仅平移」 */
export function translatePoints(pts: Vec2[], dx: number, dy: number): Vec2[] {
  return pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function makePreset(id: PresetId, n = 512): Vec2[] {
  switch (id) {
    case 'leaf': return makeLeaf(n);
    case 'lopsided': return makeLopsided(n);
    case 'circle': return makeCircle(120, n);
  }
}
