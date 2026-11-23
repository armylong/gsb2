// 地形：山坡折线 + 悬空观测/着陆台。所有碰撞都按“线段 + 纸片碰撞圆”处理，
// 因此高速时用扫掠检测，纸片不可能从地面穿过去。
import { Vec2, add, clamp, dot, len, scale, sub } from './vec';

export type TerrainKind = 'slope' | 'valley' | 'platform-edge' | 'platform-top' | 'platform-wall';

export interface TerrainSeg {
  a: Vec2;
  b: Vec2;
  kind: TerrainKind;
  /** 日志/停住提示里显示的中文段名 */
  name: string;
}

/** 观测台几何（着陆台是悬空平台，有前缘竖壁和水平台面） */
export interface Platform {
  xLeft: number;
  xRight: number;
  yTop: number;
  yBottom: number;
}

export const WORLD = { width: 300, height: 180 };

export const PLATFORM: Platform = { xLeft: 252, xRight: 296, yTop: 70, yBottom: 55 };

/** 地面折线（按 x 递增），左半段为缓山坡（坡度约 6~8°，适合滑翔），右半段是谷底 */
export const GROUND_POINTS: Vec2[] = [
  { x: 0, y: 104 },
  { x: 30, y: 100 },
  { x: 75, y: 93 },
  { x: 120, y: 82 },
  { x: 155, y: 62 },
  { x: 195, y: 40 },
  { x: 235, y: 26 },
  { x: 260, y: 21 },
  { x: 300, y: 18 },
];

function kindForIndex(i: number): TerrainKind {
  // 左半段是持续下滑的山坡，右半段是谷底缓坡
  return i <= 3 ? 'slope' : 'valley';
}

function nameForIndex(i: number): string {
  return i <= 3 ? `山坡斜坡#${i + 1}` : `谷底地面#${i + 1}`;
}

export function buildSegments(platform: Platform = PLATFORM): TerrainSeg[] {
  const segs: TerrainSeg[] = [];
  for (let i = 0; i < GROUND_POINTS.length - 1; i++) {
    segs.push({
      a: GROUND_POINTS[i],
      b: GROUND_POINTS[i + 1],
      kind: kindForIndex(i),
      name: nameForIndex(i),
    });
  }
  // 着陆台：前缘竖壁（撞边缘）、水平台面（着陆）、后缘竖壁
  segs.push({
    a: { x: platform.xLeft, y: platform.yBottom },
    b: { x: platform.xLeft, y: platform.yTop },
    kind: 'platform-edge',
    name: '着陆台前缘(边缘)',
  });
  segs.push({
    a: { x: platform.xLeft, y: platform.yTop },
    b: { x: platform.xRight, y: platform.yTop },
    kind: 'platform-top',
    name: '着陆台台面',
  });
  segs.push({
    a: { x: platform.xRight, y: platform.yTop },
    b: { x: platform.xRight, y: platform.yBottom },
    kind: 'platform-wall',
    name: '着陆台后缘壁',
  });
  return segs;
}

/** 地面折线在 x 处的高度（用于初始摆放与绘图填充） */
export function groundHeightAt(x: number): number {
  const pts = GROUND_POINTS;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 0; i < pts.length - 1; i++) {
    if (x >= pts[i].x && x <= pts[i + 1].x) {
      const t = (x - pts[i].x) / (pts[i + 1].x - pts[i].x);
      return pts[i].y + t * (pts[i + 1].y - pts[i].y);
    }
  }
  return 0;
}

export interface Contact {
  point: Vec2;
  normal: Vec2;
  depth: number;
  seg: TerrainSeg;
}

/** 圆心 c、半径 r 与线段的最近点碰撞检测 */
export function circleVsSegment(c: Vec2, r: number, seg: TerrainSeg): Contact | null {
  const ab = sub(seg.b, seg.a);
  const t = clamp(dot(sub(c, seg.a), ab) / dot(ab, ab), 0, 1);
  const closest = add(seg.a, scale(ab, t));
  const d = sub(c, closest);
  const dist = len(d);
  if (dist >= r) return null;
  // 圆心正好压在线上时，用线段法线兜底
  let normal: Vec2;
  if (dist > 1e-9) {
    normal = scale(d, 1 / dist);
  } else {
    normal = { x: -ab.y / len(ab), y: ab.x / len(ab) };
  }
  return { point: closest, normal, depth: r - dist, seg };
}

/** 静态检测：返回当前穿透最深的接触（若无接触返回 null） */
export function deepestContact(c: Vec2, r: number, segs: TerrainSeg[]): Contact | null {
  let best: Contact | null = null;
  for (const seg of segs) {
    const hit = circleVsSegment(c, r, seg);
    if (hit && (!best || hit.depth > best.depth)) best = hit;
  }
  return best;
}
