import { BranchParams, IntersectionParams, Vec2 } from './types';
import { dist, signedArea } from './util';

/** 分支矩形几何：中心线方向 d、左法向 n、半宽 h、长度 L（t∈[0,L]） */
interface BranchGeom {
  d: Vec2;
  n: Vec2;
  h: number;
  L: number;
}

function geomOf(b: BranchParams): BranchGeom {
  const th = (b.angleDeg * Math.PI) / 180;
  const d = { x: Math.cos(th), y: Math.sin(th) };
  return { d, n: { x: -d.y, y: d.x }, h: b.width / 2, L: b.length };
}

/** 分支矩形（t∈[0,L]，横向 ±h），逆时针；供末端角点计算 */
export function branchRing(b: BranchParams): [number, number][] {
  const g = geomOf(b);
  const { d, n, h, L } = g;
  return [
    [-n.x * h, -n.y * h],
    [d.x * L - n.x * h, d.y * L - n.y * h],
    [d.x * L + n.x * h, d.y * L + n.y * h],
    [n.x * h, n.y * h],
  ];
}

/** 分支末端两个角点（数学坐标） */
export function branchFarCorners(b: BranchParams): Vec2[] {
  const ring = branchRing(b);
  return [
    { x: ring[1][0], y: ring[1][1] },
    { x: ring[2][0], y: ring[2][1] },
  ];
}

// 边编号：0=左边(t=+h)，1=末端(s=L)，2=右边(t=-h)
const EDGE_LEFT = 0;
const EDGE_FAR = 1;
const EDGE_RIGHT = 2;
const DISK = -1;

/** 射线 (ux,uy) 到指定边所在直线的距离 */
function edgeRayDist(g: BranchGeom, edge: number, ux: number, uy: number): number {
  const su = ux * g.d.x + uy * g.d.y;
  const tu = ux * g.n.x + uy * g.n.y;
  if (edge === EDGE_FAR) return su > 1e-15 ? g.L / su : Infinity;
  if (edge === EDGE_LEFT) return tu > 1e-15 ? g.h / tu : Infinity;
  return tu < -1e-15 ? -g.h / tu : Infinity;
}

/** 射线穿出分支矩形的距离与边（原点位于矩形底边上，反向射线距离为 0）。命中必须落在线段范围内。 */
function rectExit(g: BranchGeom, ux: number, uy: number): { r: number; edge: number } {
  const su = ux * g.d.x + uy * g.d.y;
  const tu = ux * g.n.x + uy * g.n.y;
  let best = Infinity;
  let edge = -1;
  // 末端边 s=L：命中需 |t| ≤ h
  if (su > 1e-15) {
    const r = g.L / su;
    if (Math.abs(r * tu) <= g.h + 1e-12 && r < best) {
      best = r;
      edge = EDGE_FAR;
    }
  }
  // 左边 t=+h：命中需 0 ≤ s ≤ L
  if (tu > 1e-15) {
    const r = g.h / tu;
    const s = r * su;
    if (s >= -1e-12 && s <= g.L + 1e-12 && r < best) {
      best = r;
      edge = EDGE_LEFT;
    }
  }
  // 右边 t=-h：命中需 0 ≤ s ≤ L
  if (tu < -1e-15) {
    const r = -g.h / tu;
    const s = r * su;
    if (s >= -1e-12 && s <= g.L + 1e-12 && r < best) {
      best = r;
      edge = EDGE_RIGHT;
    }
  }
  return edge < 0 ? { r: 0, edge: -1 } : { r: best, edge };
}

const SAMPLES = 8192;
const ARC_STEP = Math.PI / 45; // 中心圆盘弧采样间隔 4°

/**
 * 星形并集轮廓：所有分支矩形都包含原点（底边中点），并集关于原点星形。
 * 沿 8192 个方向求并集边界半径（各形状射线出口距离的最大值），
 * 对边界切换角度做二分求精，精确还原每个角点；宽度台阶处产生径向边。
 * 中心叠加半径 minHalf 的圆盘，保证原点严格在并集内部（角度空档 >180° 时填平）。
 */
function unionOutline(geoms: BranchGeom[], diskR: number): Vec2[] {
  const winnerAt = (phi: number): number => {
    const ux = Math.cos(phi);
    const uy = Math.sin(phi);
    let bestR = diskR;
    let w = DISK;
    for (let i = 0; i < geoms.length; i++) {
      const { r, edge } = rectExit(geoms[i], ux, uy);
      if (r > bestR + 1e-12) {
        bestR = r;
        w = i * 3 + edge;
      }
    }
    return w;
  };
  const radiusOf = (w: number, phi: number): number => {
    if (w === DISK) return diskR;
    const ri = Math.floor(w / 3);
    const edge = w % 3;
    return edgeRayDist(geoms[ri], edge, Math.cos(phi), Math.sin(phi));
  };

  const N = SAMPLES;
  const delta = (2 * Math.PI) / N;
  const win = new Int32Array(N);
  for (let k = 0; k < N; k++) win[k] = winnerAt(k * delta);

  // 找出所有边界切换区间并二分求精
  interface Boundary {
    angle: number;
    w1: number;
    w2: number;
  }
  const boundaries: Boundary[] = [];
  for (let k = 0; k < N; k++) {
    const w1 = win[k];
    const w2 = win[(k + 1) % N];
    if (w1 === w2) continue;
    let lo = k * delta;
    let hi = (k + 1) * delta;
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      if (winnerAt(mid) === w1) lo = mid;
      else hi = mid;
    }
    boundaries.push({ angle: (lo + hi) / 2, w1, w2 });
  }

  const polar = (phi: number, r: number): Vec2 => ({ x: r * Math.cos(phi), y: r * Math.sin(phi) });
  const pts: Vec2[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    const r1 = radiusOf(b.w1, b.angle);
    const r2 = radiusOf(b.w2, b.angle);
    if (b.w1 === DISK || b.w2 === DISK || Math.abs(r1 - r2) < 1e-7) {
      // 连续角点（或圆盘交界）
      pts.push(polar(b.angle, b.w1 === DISK ? r2 : r1));
    } else {
      // 径向台阶（不同宽度道路的边缘对齐穿过原点时）
      pts.push(polar(b.angle, r1));
      pts.push(polar(b.angle, r2));
    }
    // 圆盘弧段内补充采样点
    if (b.w2 === DISK) {
      const next = i + 1 < boundaries.length ? boundaries[i + 1].angle : boundaries[0].angle + 2 * Math.PI;
      for (let a = b.angle + ARC_STEP; a < next - 1e-9; a += ARC_STEP) {
        pts.push(polar(a, diskR));
      }
    }
  }
  return pts;
}

/** 去除重复点与共线点 */
function cleanRing(pts: Vec2[]): Vec2[] {
  const eq = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 1e-8 && Math.abs(a.y - b.y) < 1e-8;
  let out = pts.slice();
  while (out.length > 1 && eq(out[0], out[out.length - 1])) out.pop();
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    const res: Vec2[] = [];
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const prev = res.length > 0 ? res[res.length - 1] : out[(i - 1 + n) % n];
      const cur = out[i];
      const nxt = out[(i + 1) % n];
      if (eq(prev, cur)) {
        changed = true;
        continue;
      }
      const ux = cur.x - prev.x;
      const uy = cur.y - prev.y;
      const vx = nxt.x - cur.x;
      const vy = nxt.y - cur.y;
      const cr = ux * vy - uy * vx;
      const scale = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      // 共线且同向（不是折返点）则移除
      if (Math.abs(cr) < 1e-8 * (scale + 1) && ux * vx + uy * vy > 0) {
        changed = true;
        continue;
      }
      res.push(cur);
    }
    out = res;
    if (!changed) break;
  }
  return out;
}

/** 相邻边短于此值的角视为数值微角，不倒角也不参与半径收缩警告 */
const MICRO_EDGE = 0.1;

/**
 * 路缘圆角：路口的转角是并集轮廓上的凹角（内角 270° 的肘部），
 * 圆角以角点为圆心、半径 r 向外鼓出，平顺连接相邻两条道路边界。
 * 道路末端的凸角保持直角。半径按相邻边长自动收缩，保证切点不越界。
 */
function filletPolygon(
  pts: Vec2[],
  endCorners: Vec2[],
  radius: number,
  warnings: string[]
): Vec2[] {
  if (radius <= 0) return pts;
  const isEnd = (p: Vec2) => endCorners.some((c) => dist(c, p) < 1e-4);
  const out: Vec2[] = [];
  let minEff = Infinity;
  let clamped = false;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const P = pts[i];
    const A = pts[(i - 1 + n) % n];
    const B = pts[(i + 1) % n];
    const ux = A.x - P.x;
    const uy = A.y - P.y;
    const vx = B.x - P.x;
    const vy = B.y - P.y;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    const turn = (P.x - A.x) * (B.y - P.y) - (P.y - A.y) * (B.x - P.x);
    const reflex = turn < -1e-12; // 逆时针多边形的凹角（路口肘部）
    if (!reflex || isEnd(P) || lu < MICRO_EDGE || lv < MICRO_EDGE) {
      out.push(P);
      continue;
    }
    const u1 = { x: ux / lu, y: uy / lu };
    const u2 = { x: vx / lv, y: vy / lv };
    const rEff = Math.min(radius, 0.49 * Math.min(lu, lv));
    if (rEff < radius - 1e-9) clamped = true;
    minEff = Math.min(minEff, rEff);
    if (rEff < 1e-4) {
      out.push(P);
      continue;
    }
    // 圆弧以 P 为圆心，切点沿两条边各距角点 rEff
    const T1 = { x: P.x + u1.x * rEff, y: P.y + u1.y * rEff };
    const T2 = { x: P.x + u2.x * rEff, y: P.y + u2.y * rEff };
    const a1 = Math.atan2(u1.y, u1.x);
    const a2 = Math.atan2(u2.y, u2.x);
    let sweep = a2 - a1;
    while (sweep <= -Math.PI) sweep += 2 * Math.PI;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    // 弧应经过外角平分线一侧（凹角的外部）
    let bx = u1.x + u2.x;
    let by = u1.y + u2.y;
    const bl = Math.hypot(bx, by);
    if (bl > 1e-12) {
      bx /= bl;
      by /= bl;
      const midAng = a1 + sweep / 2;
      if (Math.cos(midAng) * bx + Math.sin(midAng) * by < 0) {
        sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
      }
    }
    const segs = Math.max(3, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
    out.push(T1);
    for (let k = 1; k < segs; k++) {
      const a = a1 + (sweep * k) / segs;
      out.push({ x: P.x + rEff * Math.cos(a), y: P.y + rEff * Math.sin(a) });
    }
    out.push(T2);
  }
  if (clamped && Number.isFinite(minEff)) {
    warnings.push(`转角半径受几何限制，部分转角实际生效半径约 ${minEff.toFixed(2)}`);
  }
  return out;
}

export interface OutlineResult {
  /** 最终外轮廓（逆时针，含圆角采样点） */
  points: Vec2[];
  warnings: string[];
  /** 中心圆盘半径，供路口核心区判定 */
  diskRadius: number;
}

/**
 * 构建路口外轮廓：星形并集 + 路缘圆角。
 * 得到单一无重叠的轮廓，避免矩形互压。
 */
export function buildOutline(params: IntersectionParams): OutlineResult {
  const warnings: string[] = [];
  const geoms = params.branches.map(geomOf);
  const minHalf = Math.min(...geoms.map((g) => g.h));
  const diskRadius = minHalf;
  let pts = unionOutline(geoms, diskRadius);
  pts = cleanRing(pts);
  if (signedArea(pts) < 0) pts = pts.reverse();
  const endCorners = params.branches.flatMap(branchFarCorners);
  pts = filletPolygon(pts, endCorners, params.cornerRadius, warnings);
  return { points: pts, warnings, diskRadius };
}
