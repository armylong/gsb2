import type {
  BoundaryEdge,
  SideWallStatus,
  ThickenedSolid,
  Vec3,
} from './types';
import { readVec3 } from './vec';

export interface BoundaryEdgeTrace {
  sideTriangleIndex: number;
  edge: BoundaryEdge;
  loopId: number;
  loopKind: 'outer' | 'hole';
  endpoints: [Vec3, Vec3];
  offsetEndpoints: [Vec3, Vec3];
  edgeLength: number;
  offsetEdgeLength: number;
  sourceTriangle: number;
  sourceTriangleIndices: [number, number, number];
  sourceTriangleVertices: [Vec3, Vec3, Vec3];
  sourceTriangleNormal: Vec3;
  wall: SideWallStatus;
}

/**
 * 点选侧壁三角形 -> 它对应的源网格边界边、源三角形及端点。
 * sideTriangleIndex 是 sideIndices 中的三角形序号 (不是全局 triangle id)。
 */
export function boundaryEdgeTrace(
  solid: ThickenedSolid,
  sideTriangleIndex: number,
): BoundaryEdgeTrace | null {
  if (!Number.isInteger(sideTriangleIndex)) return null;
  const meta = solid.sideFaces[sideTriangleIndex];
  if (!meta) return null;
  const edge = solid.model.boundaryEdges[meta.edgeId];
  if (!edge) return null;
  const wall = solid.sideWalls.find((item) => item.edgeId === meta.edgeId);
  if (!wall) return null;

  const sourceBase = solid.model.positions.length / 3;
  const edgeA = readVec3(solid.model.positions, edge.a);
  const edgeB = readVec3(solid.model.positions, edge.b);
  const offsetA = readVec3(solid.positions, edge.a + sourceBase);
  const offsetB = readVec3(solid.positions, edge.b + sourceBase);

  const t = edge.sourceTriangle * 3;
  const model = solid.model;
  const sourceTriangleVertices: [Vec3, Vec3, Vec3] = [
    readVec3(model.positions, model.indices[t]),
    readVec3(model.positions, model.indices[t + 1]),
    readVec3(model.positions, model.indices[t + 2]),
  ];
  const p = sourceTriangleVertices;
  const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
  const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;

  return {
    sideTriangleIndex,
    edge,
    loopId: meta.loopId,
    loopKind: meta.loopKind,
    endpoints: [edgeA, edgeB],
    offsetEndpoints: [offsetA, offsetB],
    edgeLength: wall.edgeLength,
    offsetEdgeLength: wall.topEdgeLength,
    sourceTriangle: edge.sourceTriangle,
    sourceTriangleIndices: [model.indices[t], model.indices[t + 1], model.indices[t + 2]],
    sourceTriangleVertices,
    sourceTriangleNormal: [n[0] / len, n[1] / len, n[2] / len],
    wall,
  };
}

export interface WallReport {
  normal: SideWallStatus[];
  problem: SideWallStatus[];
  problemEdgeIds: Set<number>;
  problemOuter: number;
  problemHole: number;
  normalOuter: number;
  normalHole: number;
  outerEdgeCount: number;
  holeEdgeCount: number;
  byReason: { flipped: number; intersects: number; degenerate: number };
}

/** 把侧壁分成"正常"与"问题"两组, 供视图分色显示 */
export function wallReport(solid: ThickenedSolid): WallReport {
  const normal: SideWallStatus[] = [];
  const problem: SideWallStatus[] = [];
  const problemEdgeIds = new Set<number>();
  const byReason = { flipped: 0, intersects: 0, degenerate: 0 };
  let problemOuter = 0;
  let problemHole = 0;
  let normalOuter = 0;
  let normalHole = 0;

  for (const wall of solid.sideWalls) {
    if (wall.problem) {
      problem.push(wall);
      problemEdgeIds.add(wall.edgeId);
      if (wall.loopKind === 'outer') problemOuter++;
      else problemHole++;
      if (wall.flipped) byReason.flipped++;
      if (wall.intersects) byReason.intersects++;
      if (wall.degenerate) byReason.degenerate++;
    } else {
      normal.push(wall);
      if (wall.loopKind === 'outer') normalOuter++;
      else normalHole++;
    }
  }

  return {
    normal,
    problem,
    problemEdgeIds,
    problemOuter,
    problemHole,
    normalOuter,
    normalHole,
    outerEdgeCount: solid.sideWalls.filter((wall) => wall.loopKind === 'outer').length,
    holeEdgeCount: solid.sideWalls.filter((wall) => wall.loopKind === 'hole').length,
    byReason,
  };
}
