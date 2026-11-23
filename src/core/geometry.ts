import type { TopologyReport, Vec3 } from './types';
import {
  add,
  closestPointOnTriangle,
  cross,
  distance,
  dot,
  length,
  normalize,
  scale,
  sub,
  triangleArea,
  triangleNormal,
} from './vec';

export interface IndexTriple {
  a: number;
  b: number;
  c: number;
}

export function triangleVertices(
  positions: Float32Array,
  tri: IndexTriple,
): [Vec3, Vec3, Vec3] {
  return [
    [positions[tri.a * 3], positions[tri.a * 3 + 1], positions[tri.a * 3 + 2]],
    [positions[tri.b * 3], positions[tri.b * 3 + 1], positions[tri.b * 3 + 2]],
    [positions[tri.c * 3], positions[tri.c * 3 + 1], positions[tri.c * 3 + 2]],
  ];
}

/** 统计闭合性/流形性/欧拉示性数/有符号体积 */
export function analyzeTopology(
  positions: Float32Array,
  triangles: IndexTriple[],
  vertexCount: number,
): TopologyReport {
  const edges = new Map<string, { count: number; forward: number; backward: number }>();
  const referenced = new Set<number>();
  let degenerate = 0;

  for (const tri of triangles) {
    referenced.add(tri.a);
    referenced.add(tri.b);
    referenced.add(tri.c);
    const [a, b, c] = triangleVertices(positions, tri);
    if (!(triangleArea(a, b, c) > 1e-12) || tri.a === tri.b || tri.b === tri.c || tri.a === tri.c) {
      degenerate++;
      continue;
    }
    const pairs: Array<[number, number]> = [
      [tri.a, tri.b],
      [tri.b, tri.c],
      [tri.c, tri.a],
    ];
    for (const [from, to] of pairs) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      let record = edges.get(key);
      if (!record) {
        record = { count: 0, forward: 0, backward: 0 };
        edges.set(key, record);
      }
      record.count++;
      if (from < to) record.forward++;
      else record.backward++;
    }
  }

  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let inconsistentEdgeCount = 0;
  for (const record of edges.values()) {
    if (record.count === 1) boundaryEdgeCount++;
    else if (record.count > 2) nonManifoldEdgeCount++;
    else if (record.forward !== 1 || record.backward !== 1) inconsistentEdgeCount++;
  }

  let signedVolume = 0;
  for (const tri of triangles) {
    const [a, b, c] = triangleVertices(positions, tri);
    signedVolume += dot(a, cross(b, c)) / 6;
  }

  return {
    vertexCount,
    triangleCount: triangles.length,
    edgeCount: edges.size,
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    inconsistentEdgeCount,
    degenerateTriangleCount: degenerate,
    closed: boundaryEdgeCount === 0,
    manifold: nonManifoldEdgeCount === 0 && inconsistentEdgeCount === 0,
    eulerCharacteristic: referenced.size - edges.size + triangles.length,
    signedVolume,
    orientationPositive: signedVolume > 0,
  };
}

type Point2 = [number, number];

function projectTo2D(p: Vec3, dropAxis: 0 | 1 | 2): Point2 {
  if (dropAxis === 0) return [p[1], p[2]];
  if (dropAxis === 1) return [p[0], p[2]];
  return [p[0], p[1]];
}

function orient2D(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function polygonArea2D(points: Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    area += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(area) * 0.5;
}

/** 用凸多边形 clip 裁剪 convex 多边形, 返回交集多边形 */
function clipPolygon(subject: Point2[], clip: Point2[]): Point2[] {
  const orientation = Math.sign(orient2D(clip[0], clip[1], clip[2])) || 1;
  let polygon = subject.slice();
  for (let edge = 0; edge < clip.length && polygon.length > 0; edge++) {
    const p1 = clip[edge];
    const p2 = clip[(edge + 1) % clip.length];
    const output: Point2[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const current = polygon[i];
      const previous = polygon[(i + polygon.length - 1) % polygon.length];
      const dCurrent = orient2D(p1, p2, current) * orientation;
      const dPrevious = orient2D(p1, p2, previous) * orientation;
      if (dCurrent >= 0) {
        if (dPrevious < 0) {
          const t = dPrevious / (dPrevious - dCurrent);
          output.push([
            previous[0] + (current[0] - previous[0]) * t,
            previous[1] + (current[1] - previous[1]) * t,
          ]);
        }
        output.push(current);
      } else if (dPrevious >= 0) {
        const t = dPrevious / (dPrevious - dCurrent);
        output.push([
          previous[0] + (current[0] - previous[0]) * t,
          previous[1] + (current[1] - previous[1]) * t,
        ]);
      }
    }
    polygon = output;
  }
  return polygon;
}

function pickDropAxis(normal: Vec3): 0 | 1 | 2 {
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
}

/** 近共面三角形的重叠判定: 投影后用裁剪求交面积, 只把有正面积的重叠计为穿插 */
function coplanarOverlap(
  A: [Vec3, Vec3, Vec3],
  B: [Vec3, Vec3, Vec3],
  normal: Vec3,
  minArea: number,
): Vec3 | null {
  const drop = pickDropAxis(normal);
  const a2 = A.map((p) => projectTo2D(p, drop));
  const b2 = B.map((p) => projectTo2D(p, drop));
  const overlap = clipPolygon(a2, b2);
  if (overlap.length < 3) return null;
  const area = polygonArea2D(overlap);
  const aArea = polygonArea2D(a2);
  const bArea = polygonArea2D(b2);
  if (area < minArea || area < Math.min(aArea, bArea) * 0.02) return null;

  // 交集多边形重心 -> 用 A 的重心坐标还原到 3D
  let cx = 0;
  let cy = 0;
  for (const p of overlap) {
    cx += p[0];
    cy += p[1];
  }
  cx /= overlap.length;
  cy /= overlap.length;
  const a0 = projectTo2D(A[0], drop);
  const e1: Point2 = [projectTo2D(A[1], drop)[0] - a0[0], projectTo2D(A[1], drop)[1] - a0[1]];
  const e2: Point2 = [projectTo2D(A[2], drop)[0] - a0[0], projectTo2D(A[2], drop)[1] - a0[1]];
  const d: Point2 = [cx - a0[0], cy - a0[1]];
  const denom = e1[0] * e2[1] - e1[1] * e2[0];
  const v = denom !== 0 ? (d[0] * e2[1] - d[1] * e2[0]) / denom : 0;
  const w = denom !== 0 ? (e1[0] * d[1] - e1[1] * d[0]) / denom : 0;
  return add(A[0], add(scale(sub(A[1], A[0]), v), scale(sub(A[2], A[0]), w)));
}

function characteristicLength(A: [Vec3, Vec3, Vec3], B: [Vec3, Vec3, Vec3]): number {
  let longest = 0;
  for (const tri of [A, B]) {
    longest = Math.max(
      longest,
      distance(tri[0], tri[1]),
      distance(tri[1], tri[2]),
      distance(tri[2], tri[0]),
    );
  }
  return longest;
}

function planeCutSegment(
  tri: [Vec3, Vec3, Vec3],
  d: [number, number, number],
  tol: number,
): Vec3[] | null {
  const points: Vec3[] = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const di = d[i];
    const dj = d[j];
    if (Math.abs(di) <= tol) points.push(tri[i]);
    if ((di > tol && dj < -tol) || (di < -tol && dj > tol)) {
      const t = di / (di - dj);
      points.push(add(tri[i], scale(sub(tri[j], tri[i]), t)));
    }
  }
  const unique: Vec3[] = [];
  for (const p of points) {
    if (!unique.some((q) => distance(p, q) <= tol)) unique.push(p);
  }
  return unique.length >= 2 ? unique : null;
}

/**
 * 三角形-三角形相交判定。
 *
 * A 与平面 B 的割线段、B 与平面 A 的割线段都落在两平面的交线上。
 * 比较两条线段沿交线的参数区间即可; 仅共享顶点或共边接触 (区间长度
 * 不超过容差) 不算穿插。近共面时改用 2D 投影裁剪, 要求正重叠面积。
 */
export function triangleTriangleIntersection(
  A: [Vec3, Vec3, Vec3],
  B: [Vec3, Vec3, Vec3],
): Vec3 | null {
  const nA = triangleNormal(A[0], A[1], A[2]);
  const nB = triangleNormal(B[0], B[1], B[2]);
  const lenA = length(nA);
  const lenB = length(nB);
  const scaleHint = characteristicLength(A, B);
  if (scaleHint <= 0) return null;
  const areaEps = scaleHint * scaleHint * 1e-9;
  if (lenA < areaEps || lenB < areaEps) return null;

  const unitA = normalize(nA);
  const unitB = normalize(nB);
  const planeTol = scaleHint * 1e-6;

  const dA: [number, number, number] = [
    dot(sub(A[0], B[0]), unitB),
    dot(sub(A[1], B[0]), unitB),
    dot(sub(A[2], B[0]), unitB),
  ];
  if (dA.every((v) => v > planeTol) || dA.every((v) => v < -planeTol)) return null;

  const dB: [number, number, number] = [
    dot(sub(B[0], A[0]), unitA),
    dot(sub(B[1], A[0]), unitA),
    dot(sub(B[2], A[0]), unitA),
  ];
  if (dB.every((v) => v > planeTol) || dB.every((v) => v < -planeTol)) return null;

  if (dA.every((v) => Math.abs(v) <= planeTol)) {
    return coplanarOverlap(A, B, unitA, areaEps);
  }

  const segA = planeCutSegment(A, dA, planeTol);
  const segB = planeCutSegment(B, dB, planeTol);
  if (!segA || !segB) return null;

  const dir = cross(unitA, unitB);
  const dirLen = length(dir);
  if (dirLen < 1e-9) return null;
  const unitDir = scale(dir, 1 / dirLen);

  const paramA = segA.map((p) => dot(p, unitDir));
  const paramB = segB.map((p) => dot(p, unitDir));
  const lo = Math.max(Math.min(...paramA), Math.min(...paramB));
  const hi = Math.min(Math.max(...paramA), Math.max(...paramB));
  if (hi - lo <= planeTol) return null;

  const target = (lo + hi) / 2;
  let best = segA[0];
  let bestDelta = Infinity;
  for (const p of [...segA, ...segB]) {
    const delta = Math.abs(dot(p, unitDir) - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = p;
    }
  }
  return best;
}

/** 点到全部三角形的最近点; 用于测量局部厚度 */
export function closestPointOnMesh(
  p: Vec3,
  positions: Float32Array,
  triangles: IndexTriple[],
  filter?: (triangleIndex: number) => boolean,
): { point: Vec3; distance: number } | null {
  let best: Vec3 | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i < triangles.length; i++) {
    if (filter && !filter(i)) continue;
    const [a, b, c] = triangleVertices(positions, triangles[i]);
    const centroid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const bound = distance(centroid, p) + Math.max(distance(a, b), distance(b, c), distance(c, a));
    // 最近点不可能优于已有上界时剔除; best 为空时不能剪掉第一个候选
    if (best !== null && bound <= bestDistance) continue;
    const closest = closestPointOnTriangle(p, a, b, c);
    const d = distance(p, closest);
    if (d < bestDistance) {
      bestDistance = d;
      best = closest;
    }
  }
  if (!best) return null;
  return { point: best, distance: bestDistance };
}

export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const la = length(a);
  const lb = length(b);
  if (la < 1e-14 || lb < 1e-14) return 0;
  const cosine = Math.min(1, Math.max(-1, dot(a, b) / (la * lb)));
  return (Math.acos(cosine) * 180) / Math.PI;
}
