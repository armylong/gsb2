/**
 * 隐藏线消隐引擎（纯 TypeScript，无 three.js 依赖）。
 *
 * 算法：
 *  1. 所有顶点按正交视图投影到屏幕（NDC [-1,1]^2 + 视线深度）。
 *  2. 每条边先做视野框 Liang-Barsky 裁剪，框外部分直接丢弃。
 *  3. 对每个朝相机的三角面，用三个朝内半平面求"边参数 t 上的屏幕重叠区间"；
 *     区间中点做深度比较，边比面远（含同深 epsilon 规则）则记为遮挡。
 *  4. 合并遮挡区间 -> 一条边输出若干可见实线段 / 隐藏虚线段。
 *
 * 确定性：所有排序只使用几何值与稳定 id，与三角面/边的遍历顺序无关；
 * 同一条物理边在任意视角、任意输入顺序下结果一致。
 */

import type { Vec3 } from './math3d.ts';
import { sub, dot, clamp } from './math3d.ts';
import type { WorldMesh, EdgeInfo } from './geometry.ts';
import type { ViewDescriptor, ViewBasis, ScreenPoint } from './view.ts';
import { makeBasis, project } from './view.ts';

export type SegmentKind = 'visible' | 'hidden';

export interface LineSegment {
  id: string;
  edgeId: string;
  partId: string;
  partIndex: number;
  edgeIndex: number;
  kind: SegmentKind;
  /** 在原边 P0 + t*(P1-P0) 上的参数区间。 */
  t0: number;
  t1: number;
  /** NDC 屏幕坐标。 */
  x0: number; y0: number; x1: number; y1: number;
  /** 段中点深度（越大越远），仅用于确定性的绘制排序。 */
  depth: number;
  /** 隐藏段：挡住该区间的零件 id（去重排序）。实线段为空数组。 */
  occluderPartIds: string[];
  /** 隐藏段：遮挡面索引（调试/高亮用）。 */
  occluderTriIndices: number[];
}

export interface ProjectedTriangle {
  triIndex: number;
  partIndex: number;
  sx: [number, number, number];
  sy: [number, number, number];
  sd: [number, number, number];
  frontFacing: boolean;
  /** 屏幕面积两倍，接近 0 表示退化（侧视成线），不参与遮挡。 */
  area2: number;
  incidentEdgeIds: Set<string>;
}

export interface HLRResult {
  view: ViewDescriptor;
  thresholdDeg: number;
  depthEps: number;
  segments: LineSegment[];
  /** 参与计算的边（世界坐标端点 + 入射面），供 3D 高亮。 */
  edgeRecords: Array<{
    edge: EdgeInfo;
    partId: string;
    worldA: Vec3;
    worldB: Vec3;
  }>;
  generatedAt: string;
}

const PARAM_EPS = 1e-9;
const NORMAL_EPS = 1e-9;
const SCREEN_EPS = 1e-9;

/**
 * Liang-Barsky 裁剪到 NDC [-1,1]^2。
 * 对轴 u（屏幕坐标 s）定义：
 *   p1 = -d, q1 = p0 + 1   -> 约束 s >= -1
 *   p2 =  d, q2 = 1 - p0   -> 约束 s <= 1
 * p<0 的约束给下界 t >= q/p，p>0 给上界 t <= q/p。
 */
function clipToFrame(p0: ScreenPoint, p1: ScreenPoint): [number, number] | null {
  let lo = 0;
  let hi = 1;
  const dims: Array<[number, number]> = [
    [p0.x, p1.x],
    [p0.y, p1.y]
  ];
  for (const [s0, s1] of dims) {
    const d = s1 - s0;
    const pq: Array<[number, number]> = [
      [-d, s0 + 1],
      [d, 1 - s0]
    ];
    for (const [p, q] of pq) {
      if (Math.abs(p) < PARAM_EPS) {
        // 平行于该边界：q<0 表示整条边在外侧
        if (q < -PARAM_EPS) return null;
        continue;
      }
      const r = q / p;
      if (p < 0) {
        if (r > lo) lo = r;
      } else {
        if (r < hi) hi = r;
      }
      if (lo > hi + PARAM_EPS) return null;
    }
  }
  if (hi - lo < PARAM_EPS) return null;
  return [clamp(lo, 0, 1), clamp(hi, 0, 1)];
}

interface RawInterval {
  lo: number;
  hi: number;
  triIndex: number;
  partIndex: number;
}

/**
 * 2D 参数边 P(t)=P0+t*d 与三角形的重叠参数区间（半平面裁剪）。
 * 半平面朝向由第三个顶点确定，与三角形屏幕绕向无关。
 */
function segmentTriangleOverlap(
  p0x: number, p0y: number, dx: number, dy: number,
  tri: ProjectedTriangle,
  tLo: number, tHi: number
): [number, number] | null {
  let lo = tLo;
  let hi = tHi;
  for (let e = 0; e < 3; e++) {
    const i = e;
    const j = (e + 1) % 3;
    const ax = tri.sx[i];
    const ay = tri.sy[i];
    const bx = tri.sx[j];
    const by = tri.sy[j];
    // 边 A->B 的法向量（两个候选方向之一），用第三个顶点选朝内的那个
    let nx = -(by - ay);
    let ny = bx - ax;
    const cx = tri.sx[(e + 2) % 3];
    const cy = tri.sy[(e + 2) % 3];
    if (nx * (cx - ax) + ny * (cy - ay) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const h0 = nx * (p0x - ax) + ny * (p0y - ay);
    const hd = nx * dx + ny * dy;
    if (Math.abs(hd) < SCREEN_EPS) {
      if (h0 < -SCREEN_EPS) return null; // 整条边在该半平面外
      continue;
    }
    // 内侧条件 h0 + hd*t >= 0：hd>0 时 t >= bound（抬高下界），反之 t <= bound（压低上界）
    const bound = -h0 / hd;
    if (hd > 0) {
      lo = Math.max(lo, bound);
    } else {
      hi = Math.min(hi, bound);
    }
    if (lo > hi + SCREEN_EPS) return null;
  }
  if (hi - lo < PARAM_EPS) return null;
  return [Math.max(lo, tLo), Math.min(hi, tHi)];
}

/** 屏幕点 (px,py) 在三角形上的重心坐标深度；退化时返回 null。 */
function triangleDepthAt(tri: ProjectedTriangle, px: number, py: number): number | null {
  const [x0, x1, x2] = tri.sx;
  const [y0, y1, y2] = tri.sy;
  const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
  if (Math.abs(denom) < SCREEN_EPS) return null;
  const w0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / denom;
  const w1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / denom;
  const w2 = 1 - w0 - w1;
  return w0 * tri.sd[0] + w1 * tri.sd[1] + w2 * tri.sd[2];
}

export interface HLROptions {
  depthEps?: number;
}

export function runHLR(
  mesh: WorldMesh,
  view: ViewDescriptor,
  thresholdDeg: number,
  opts: HLROptions = {}
): HLRResult {
  const basis = makeBasis(view);
  const sceneSize = estimateSize(mesh);
  const depthEps = opts.depthEps ?? sceneSize * 1e-7;

  // 1) 投影全部顶点
  const projected: ScreenPoint[] = mesh.vertices.map((p) => project(basis, p));

  // 2) 投影三角面。不依赖输入网格的绕向/法线朝向：
  //    遮挡关系完全由屏幕重叠 + 深度测试决定，朝正面标记仅用于调试展示。
  const projTris: ProjectedTriangle[] = mesh.triangles.map((t, triIndex) => {
    const [a, b, c] = t.v;
    const pa = projected[a];
    const pb = projected[b];
    const pc = projected[c];
    const area2 =
      (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
    const frontFacing = dot(t.normal, basis.f) < -NORMAL_EPS;
    return {
      triIndex,
      partIndex: t.partIndex,
      sx: [pa.x, pb.x, pc.x],
      sy: [pa.y, pb.y, pc.y],
      sd: [pa.depth, pb.depth, pc.depth],
      frontFacing,
      area2: Math.abs(area2),
      incidentEdgeIds: new Set<string>()
    };
  });

  // 边 -> 入射三角面集合：直接由三角面的世界顶点索引反推，
  // 不依赖 edge.faces 的索引空间，避免任何排序/基址错位。
  const edgeKeyToId = new Map<string, string>();
  for (const edge of mesh.edges) {
    const lo = Math.min(edge.a, edge.b);
    const hi = Math.max(edge.a, edge.b);
    edgeKeyToId.set(`${lo},${hi}`, edge.id);
  }
  projTris.forEach((pt, ti) => {
    const tri = mesh.triangles[ti];
    const corners = tri.v;
    const pairs: Array<[number, number]> = [
      [corners[0], corners[1]],
      [corners[1], corners[2]],
      [corners[2], corners[0]]
    ];
    for (const [u, w] of pairs) {
      const lo = Math.min(u, w);
      const hi = Math.max(u, w);
      const id = edgeKeyToId.get(`${lo},${hi}`);
      if (id) pt.incidentEdgeIds.add(id);
    }
  });

  // 可作为遮挡物的面：背向相机（法线 dot f > 0，即实体远侧表面）且屏幕投影非退化。
  // 用世界法线判断而非屏幕绕向，对输入三角汤的绕向不一致天然稳健；
  // 靠近相机的面永远不会遮挡它自身或更前方的边。数组顺序即 triIndex 升序，天然确定。
  const occluders = projTris.filter(
    (t) => t.area2 > SCREEN_EPS && dot(mesh.triangles[t.triIndex].normal, basis.f) > NORMAL_EPS
  );

  const segments: LineSegment[] = [];
  const edgeRecords: HLRResult['edgeRecords'] = [];

  // 3) 逐边求遮挡区间
  mesh.edges.forEach((edge, edgeIndex) => {
    const pa = projected[edge.a];
    const pb = projected[edge.b];
    const clip = clipToFrame(pa, pb);
    if (!clip) return; // 整条边在视野框外：不出图
    const [cLo, cHi] = clip;

    const worldA = mesh.vertices[edge.a];
    const worldB = mesh.vertices[edge.b];
    edgeRecords.push({ edge, partId: mesh.parts[edge.partIndex].id, worldA, worldB });

    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const raw: RawInterval[] = [];

    for (const tri of occluders) {
      // 同零件的入射面不遮挡自己的边；其余面（含同零件远侧面）正常参与
      if (tri.partIndex === edge.partIndex && tri.incidentEdgeIds.has(edge.id)) continue;

      const overlap = segmentTriangleOverlap(pa.x, pa.y, dx, dy, tri, cLo, cHi);
      if (!overlap) continue;
      const [lo, hi] = overlap;
      const tm = (lo + hi) * 0.5;
      const mx = pa.x + dx * tm;
      const my = pa.y + dy * tm;
      const edgeDepth = pa.depth + (pb.depth - pa.depth) * tm;
      const triDepth = triangleDepthAt(tri, mx, my);
      if (triDepth === null) continue;
      // 稳定同深规则：深度差小于 depthEps 视为共面，tie 归边（判可见）。
      if (edgeDepth - triDepth >= depthEps) {
        raw.push({ lo, hi, triIndex: tri.triIndex, partIndex: tri.partIndex });
      }
    }

    // 4) 确定性排序 + 区间合并
    raw.sort((r1, r2) =>
      r1.lo - r2.lo || r1.hi - r2.hi || r1.triIndex - r2.triIndex
    );
    const merged: Array<{ lo: number; hi: number; tris: number[]; parts: number[] }> = [];
    for (const iv of raw) {
      const last = merged[merged.length - 1];
      if (last && iv.lo <= last.hi + PARAM_EPS) {
        last.hi = Math.max(last.hi, iv.hi);
        last.tris.push(iv.triIndex);
        last.parts.push(iv.partIndex);
      } else {
        merged.push({ lo: iv.lo, hi: iv.hi, tris: [iv.triIndex], parts: [iv.partIndex] });
      }
    }

    const partId = mesh.parts[edge.partIndex].id;
    const emit = (t0: number, t1: number, kind: SegmentKind, iv?: typeof merged[number]): void => {
      if (t1 - t0 < PARAM_EPS) return;
      const x0 = pa.x + dx * t0;
      const y0 = pa.y + dy * t0;
      const x1 = pa.x + dx * t1;
      const y1 = pa.y + dy * t1;
      const occluderPartIds = iv
        ? Array.from(new Set(iv.parts.map((pi) => mesh.parts[pi].id))).sort()
        : [];
      segments.push({
        id: `${edge.id}@${kind === 'visible' ? 'v' : 'h'}@${segments.length}`,
        edgeId: edge.id,
        partId,
        partIndex: edge.partIndex,
        edgeIndex,
        kind,
        t0,
        t1,
        x0,
        y0,
        x1,
        y1,
        depth: (pa.depth + pb.depth) * 0.5,
        occluderPartIds,
        occluderTriIndices: iv ? Array.from(new Set(iv.tris)).sort((a, b) => a - b) : []
      });
    };

    let cursor = cLo;
    for (const iv of merged) {
      emit(cursor, iv.lo, 'visible');
      emit(iv.lo, iv.hi, 'hidden', iv);
      cursor = iv.hi;
    }
    emit(cursor, cHi, 'visible');
  });

  // 5) 绘制顺序确定：隐藏虚线先画；可见线远 -> 近，同深按 part/edge id 兜底
  segments.sort((s1, s2) => {
    if (s1.kind !== s2.kind) return s1.kind === 'hidden' ? -1 : 1;
    if (s1.kind === 'visible') {
      if (Math.abs(s1.depth - s2.depth) > depthEps) return s2.depth - s1.depth;
    }
    if (s1.partIndex !== s2.partIndex) return s1.partIndex - s2.partIndex;
    return s1.edgeId < s2.edgeId ? -1 : s1.edgeId > s2.edgeId ? 1 : s1.t0 - s2.t0;
  });

  return {
    view,
    thresholdDeg,
    depthEps,
    segments,
    edgeRecords,
    generatedAt: new Date(0).toISOString() // 固定值，保证导出可复现、可 diff
  };
}

function estimateSize(mesh: WorldMesh): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of mesh.vertices) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); maxZ = Math.max(maxZ, p.z);
  }
  return Math.max(
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
    1e-6
  );
}

export function edgeWorldEndpoints(mesh: WorldMesh, edgeId: string): { a: Vec3; b: Vec3; edge: EdgeInfo } | null {
  const idx = mesh.edgeById.get(edgeId);
  if (idx === undefined) return null;
  const edge = mesh.edges[idx];
  return { a: mesh.vertices[edge.a], b: mesh.vertices[edge.b], edge };
}

// 供测试使用的内部工具
export const _internal = { clipToFrame, segmentTriangleOverlap, triangleDepthAt, sub, dot };
