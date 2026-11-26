/**
 * 扫掠范围内核:
 * - samplePartOBBs: 在检查区间内均匀采样门板/托板的世界 OBB;
 * - computeEnvelope: 把 OBB 集合投影到平面并光栅化, 用 marching squares 提取包络轮廓;
 * - 渲染层直接用采样 OBB 合并成半透明三维扫掠体。
 *
 * 区间收紧时调用方重新采样/重算, 范围立即跟着收紧 (无缓存状态)。
 */
import { getPose, type Mechanism, type Pose } from './kinematics';
import { type OBB, type Vec3 } from './math3d';
import type { PartKind } from './collision';

export type Plane2D = 'top' | 'side';

export interface Point2D {
  x: number;
  y: number;
}

export interface Polygon {
  points: Point2D[];
}

export interface Raster {
  plane: Plane2D;
  /** 网格单元尺寸 (mm) */
  cell: number;
  /** 世界坐标下网格覆盖范围 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** 网格列数/行数 */
  cols: number;
  rows: number;
  /** rows+1 行、cols+1 列的角点覆盖标记 */
  grid: Uint8Array;
}

/** 区间内两个零件的 OBB 采样 */
export function samplePartOBBs(
  m: Mechanism,
  range: [number, number],
  samples: number,
): { t: number; pose: Pose; door: OBB; tray: OBB }[] {
  const out: { t: number; pose: Pose; door: OBB; tray: OBB }[] = [];
  const n = Math.max(1, Math.floor(samples));
  for (let i = 0; i <= n; i++) {
    const t = range[0] + ((range[1] - range[0]) * i) / n;
    const pose = getPose(m, t);
    out.push({ t, pose, door: pose.doorOBB, tray: pose.trayOBB });
  }
  return out;
}

export function projectPoint(p: Vec3, plane: Plane2D): Point2D {
  return plane === 'top' ? { x: p[0], y: p[2] } : { x: p[2], y: p[1] };
}

function obbProjectedCorners(o: OBB, plane: Plane2D): Point2D[] {
  const pts: Point2D[] = [];
  for (let mask = 0; mask < 8; mask++) {
    let p: Vec3 = [...o.center] as Vec3;
    for (let i = 0; i < 3; i++) {
      const sgn = mask & (1 << i) ? 1 : -1;
      p = [
        p[0] + sgn * o.half[i] * o.axes[i][0],
        p[1] + sgn * o.half[i] * o.axes[i][1],
        p[2] + sgn * o.half[i] * o.axes[i][2],
      ];
    }
    pts.push(projectPoint(p, plane));
  }
  return pts;
}

/** 判断二维点是否落在凸多边形内 (要求顶点按环绕顺序排列) */
function pointInConvex(p: Point2D, poly: Point2D[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** OBB 投影为二维凸四边形, 按极角排序保证环绕顺序 */
function projectOBB(o: OBB, plane: Plane2D): Point2D[] {
  const raw = obbProjectedCorners(o, plane);
  const uniq = new Map<string, Point2D>();
  for (const p of raw) {
    uniq.set(`${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`, p);
  }
  const arr = [...uniq.values()];
  const cx = arr.reduce((s, p) => s + p.x, 0) / arr.length;
  const cy = arr.reduce((s, p) => s + p.y, 0) / arr.length;
  arr.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  return arr;
}

/**
 * 计算 OBB 集合在指定平面上的并集包络 (光栅 + marching squares)。
 * @param cell 网格边长, mm; 越小越精细
 * @param margin 外扩边距, mm
 */
export function computeEnvelope(
  obbs: OBB[],
  plane: Plane2D,
  cell = 4,
  margin = 12,
): Raster {
  const polys = obbs.map((o) => projectOBB(o, plane));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys) {
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  minX -= margin;
  minY -= margin;
  maxX += margin;
  maxY += margin;
  const cols = Math.max(2, Math.ceil((maxX - minX) / cell));
  const rows = Math.max(2, Math.ceil((maxY - minY) / cell));
  const grid = new Uint8Array((rows + 1) * (cols + 1));

  for (let pi = 0; pi < polys.length; pi++) {
    const poly = polys[pi];
    let pMinX = Infinity;
    let pMinY = Infinity;
    let pMaxX = -Infinity;
    let pMaxY = -Infinity;
    for (const p of poly) {
      pMinX = Math.min(pMinX, p.x);
      pMaxX = Math.max(pMaxX, p.x);
      pMinY = Math.min(pMinY, p.y);
      pMaxY = Math.max(pMaxY, p.y);
    }
    const c0 = Math.max(0, Math.floor((pMinX - minX) / cell) - 1);
    const c1 = Math.min(cols, Math.ceil((pMaxX - minX) / cell) + 1);
    const r0 = Math.max(0, Math.floor((pMinY - minY) / cell) - 1);
    const r1 = Math.min(rows, Math.ceil((pMaxY - minY) / cell) + 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (grid[r * (cols + 1) + c]) continue;
        const p: Point2D = { x: minX + c * cell, y: minY + r * cell };
        if (pointInConvex(p, poly)) grid[r * (cols + 1) + c] = 1;
      }
    }
  }

  fillInteriorHoles(grid, cols, rows);
  return { plane, cell, bounds: { minX, minY, maxX, maxY }, cols, rows, grid };
}

/**
 * 采样 OBB 之间可能留下细小的未覆盖栅格 (内部空隙)。
 * 从网格外缘泛洪标记所有外部 0, 未被标记的 0 即内部空洞, 填成 1。
 */
function fillInteriorHoles(grid: Uint8Array, cols: number, rows: number): void {
  const w = cols + 1;
  const outside = new Uint8Array(grid.length);
  const stack: number[] = [];
  const push = (idx: number) => {
    if (!outside[idx] && grid[idx] === 0) {
      outside[idx] = 1;
      stack.push(idx);
    }
  };
  for (let c = 0; c <= cols; c++) {
    push(c);
    push(rows * w + c);
  }
  for (let r = 0; r <= rows; r++) {
    push(r * w);
    push(r * w + cols);
  }
  while (stack.length) {
    const idx = stack.pop()!;
    const r = Math.floor(idx / w);
    const c = idx % w;
    if (r > 0) push(idx - w);
    if (r < rows) push(idx + w);
    if (c > 0) push(idx - 1);
    if (c < cols) push(idx + 1);
  }
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === 0 && !outside[i]) grid[i] = 1;
  }
}

function gridAt(g: Raster, r: number, c: number): number {
  if (r < 0 || c < 0 || r > g.rows || c > g.cols) return 0;
  return g.grid[r * (g.cols + 1) + c];
}

/**
 * marching squares 提取外轮廓 (只取值 1->0 的边界段, 不做内部孔洞缝合,
 * 输出为闭合多边形集合; 对扫掠包络足够)。
 */
export function extractContours(g: Raster): Polygon[] {
  const segments: [Point2D, Point2D][] = [];
  const P = (r: number, c: number): Point2D => ({
    x: g.bounds.minX + c * g.cell,
    y: g.bounds.minY + r * g.cell,
  });

  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const tl = gridAt(g, r, c);
      const tr = gridAt(g, r, c + 1);
      const br = gridAt(g, r + 1, c + 1);
      const bl = gridAt(g, r + 1, c);
      const idx = (tl << 3) | (tr << 2) | (br << 1) | bl;
      const topL = P(r, c);
      const topR = P(r, c + 1);
      const botR = P(r + 1, c + 1);
      const botL = P(r + 1, c);
      const midTop: Point2D = { x: (topL.x + topR.x) / 2, y: topL.y };
      const midRight: Point2D = { x: topR.x, y: (topR.y + botR.y) / 2 };
      const midBottom: Point2D = { x: (botL.x + botR.x) / 2, y: botL.y };
      const midLeft: Point2D = { x: topL.x, y: (topL.y + botL.y) / 2 };
      // 只输出 "1 区域" 的外边界
      const edge = (a: Point2D, b: Point2D) => segments.push([a, b]);
      switch (idx) {
        case 0b0001: edge(midLeft, midBottom); break;
        case 0b0010: edge(midBottom, midRight); break;
        case 0b0011: edge(midLeft, midRight); break;
        case 0b0100: edge(midTop, midRight); break;
        case 0b0101:
          edge(midLeft, midTop);
          edge(midBottom, midRight);
          break;
        case 0b0110: edge(midTop, midBottom); break;
        case 0b0111: edge(midLeft, midTop); break;
        case 0b1000: edge(midTop, midLeft); break;
        case 0b1001: edge(midTop, midBottom); break;
        case 0b1010:
          edge(midTop, midLeft);
          edge(midRight, midBottom);
          break;
        case 0b1011: edge(midTop, midRight); break;
        case 0b1100: edge(midLeft, midRight); break;
        case 0b1101: edge(midLeft, midBottom); break;
        case 0b1110: edge(midTop, midLeft); break;
        default: break; // 0000 / 1111 无边界
      }
    }
  }

  return stitchSegments(segments);
}

/** 把首尾相接的线段沿共享端点拼成闭合多边形 (边界追踪) */
function stitchSegments(segments: [Point2D, Point2D][]): Polygon[] {
  const key = (p: Point2D) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`;
  // 端点键 -> 以该点为起点的线段下标
  const outgoing = new Map<string, number[]>();
  segments.forEach((s, i) => {
    const k = key(s[0]);
    const list = outgoing.get(k) ?? [];
    list.push(i);
    outgoing.set(k, list);
  });
  const used = new Array<boolean>(segments.length).fill(false);
  const polys: Polygon[] = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const poly: Point2D[] = [segments[start][0], segments[start][1]];
    let guard = segments.length + 1;
    while (guard-- > 0) {
      const tailKey = key(poly[poly.length - 1]);
      if (tailKey === key(poly[0])) break;
      const candidates = outgoing.get(tailKey);
      if (!candidates) break;
      const next = candidates.find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = true;
      poly.push(segments[next][1]);
    }
    // 闭合环去掉重复的收尾点
    if (poly.length > 1 && key(poly[0]) === key(poly[poly.length - 1])) poly.pop();
    if (poly.length >= 3) polys.push({ points: poly });
  }
  return polys;
}

/** 渲染层/导出层共用: 按零件拆分采样 OBB */
export function sampleOBBsByPart(
  m: Mechanism,
  range: [number, number],
  samples: number,
): Record<PartKind, OBB[]> {
  const all = samplePartOBBs(m, range, samples);
  return {
    door: all.map((s) => s.door),
    tray: all.map((s) => s.tray),
  };
}

/** 工具: 计算一组 OBB 在某平面上的包围盒 */
export function boundsOfOBBs(obbs: OBB[], plane: Plane2D, margin = 10) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const o of obbs) {
    for (const p of obbProjectedCorners(o, plane)) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  return {
    minX: minX - margin,
    minY: minY - margin,
    maxX: maxX + margin,
    maxY: maxY + margin,
  };
}
