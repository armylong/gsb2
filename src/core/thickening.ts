import { sourceTriangleNormal } from './mesh';
import {
  angleBetweenDeg,
  analyzeTopology,
  triangleTriangleIntersection,
  type IndexTriple,
} from './geometry';
import type {
  BoundaryEdge,
  FoldIssue,
  IntersectionCounts,
  IntersectionIssue,
  SideFaceMeta,
  SideWallStatus,
  SolidOptions,
  SolidTriangle,
  SurfaceModel,
  ThickenedSolid,
  TriangleKind,
  ValidationReport,
  Vec3,
} from './types';
import {
  add,
  cross,
  distance,
  dot,
  length,
  normalize,
  readVec3,
  scale,
  sub,
  triangleArea,
  writeVec3,
} from './vec';

const MAX_REPORTED_INTERSECTIONS = 4000;
const FOLD_DOT_THRESHOLD = 0;
const COLLAPSE_AREA_RATIO = 0.02;

/**
 * 加厚: 原始层保持不动, 偏移层沿顶点法线平移 t*side。
 *
 * 朝向约定 (保证实体外法线朝外):
 *   side=+1: 实体在原始面 +n 一侧, 原始层需反绕, 偏移层保持源绕序。
 *   side=-1: 实体在原始面 -n 一侧, 原始层保持源绕序, 偏移层反绕。
 *
 * 侧壁: 边界有向边在实体原始层中的方向为 p->q (随原始层绕序翻转选择),
 * 四边形拆成 (p, q', q) 与 (p, p', q'), 这两个三角形的法线都指向
 * cross(q-p, 原始层外法线) 方向, 即实体外侧。
 */
export function buildThickenedSolid(model: SurfaceModel, options: SolidOptions): ThickenedSolid {
  const builtAt = Date.now();
  const sourceCount = model.positions.length / 3;
  const positions = new Float32Array(sourceCount * 2 * 3);
  positions.set(model.positions, 0);

  const offset = new Float32Array(sourceCount * 3);
  for (let i = 0; i < sourceCount; i++) {
    const n = readVec3(model.normals, i);
    const p = readVec3(model.positions, i);
    writeVec3(offset, i, add(p, scale(n, options.thickness * options.side)));
  }
  positions.set(offset, sourceCount * 3);

  const offsetIndexBase = sourceCount;
  const sourceIndices = model.indices;
  const originalReversed = options.side > 0;
  const offsetReversed = options.side < 0;

  const originalIndices = new Uint32Array(sourceIndices.length);
  const offsetIndices = new Uint32Array(sourceIndices.length);
  for (let t = 0; t < sourceIndices.length; t += 3) {
    const a = sourceIndices[t];
    const b = sourceIndices[t + 1];
    const c = sourceIndices[t + 2];
    if (originalReversed) {
      originalIndices[t] = a;
      originalIndices[t + 1] = c;
      originalIndices[t + 2] = b;
    } else {
      originalIndices[t] = a;
      originalIndices[t + 1] = b;
      originalIndices[t + 2] = c;
    }
    if (offsetReversed) {
      offsetIndices[t] = a + offsetIndexBase;
      offsetIndices[t + 1] = c + offsetIndexBase;
      offsetIndices[t + 2] = b + offsetIndexBase;
    } else {
      offsetIndices[t] = a + offsetIndexBase;
      offsetIndices[t + 1] = b + offsetIndexBase;
      offsetIndices[t + 2] = c + offsetIndexBase;
    }
  }

  const boundaryEdges: BoundaryEdge[] = model.boundaryEdges;
  const sideIndices = new Uint32Array(boundaryEdges.length * 6);
  const sideFaces: SideFaceMeta[] = [];
  const sideWalls: SideWallStatus[] = [];

  let write = 0;
  for (const edge of boundaryEdges) {
    const p = originalReversed ? edge.b : edge.a;
    const q = originalReversed ? edge.a : edge.b;
    const pPrime = originalReversed ? edge.b + offsetIndexBase : edge.a + offsetIndexBase;
    const qPrime = originalReversed ? edge.a + offsetIndexBase : edge.b + offsetIndexBase;

    // 两个三角形: (p, q', q) 与 (p, p', q')
    const tris: Array<[number, number, number]> = [
      [p, qPrime, q],
      [p, pPrime, qPrime],
    ];
    for (let k = 0; k < 2; k++) {
      const [a, b, c] = tris[k];
      sideIndices[write++] = a;
      sideIndices[write++] = b;
      sideIndices[write++] = c;
      sideFaces.push({
        edgeId: edge.id,
        loopId: edge.loopId,
        loopKind: edge.loopKind,
        a: edge.a,
        b: edge.b,
        sourceTriangle: edge.sourceTriangle,
        quadTriangle: k as 0 | 1,
      });
    }

    const pa = readVec3(model.positions, edge.a);
    const pb = readVec3(model.positions, edge.b);
    const paPrime = readVec3(offset, edge.a);
    const pbPrime = readVec3(offset, edge.b);
    const nAvg = normalize(add(
      readVec3(model.normals, edge.a),
      readVec3(model.normals, edge.b),
    ));
    // 侧壁外法线 = 加厚方向 × 侧壁四边形沿边方向 (p -> q)。
    // 用实际四边形方向而不是源边方向, 因为 side=+1 时原始层反绕。
    const wallDirection = sub(readVec3(positions, q), readVec3(positions, p));
    const outward = normalize(cross(scale(nAvg, options.side), wallDirection));
    const wallTriangles: Array<[Vec3, Vec3, Vec3]> = [
      [readVec3(positions, p), readVec3(positions, qPrime), readVec3(positions, q)],
      [readVec3(positions, p), readVec3(positions, pPrime), readVec3(positions, qPrime)],
    ];
    let maxDeviation = 0;
    let degenerate = false;
    let flipped = false;
    let areas: number[] = [];
    for (const [a, b, c] of wallTriangles) {
      const area = triangleArea(a, b, c);
      areas.push(area);
      const normal = cross(sub(b, a), sub(c, a));
      if (length(normal) < 1e-14 || area < 1e-10) degenerate = true;
      const deviation = angleBetweenDeg(normal, outward);
      if (deviation > maxDeviation) maxDeviation = deviation;
      // 法线与期望外法线夹角超过 90° 视为翻转
      if (dot(normal, outward) < 0) flipped = true;
    }

    sideWalls.push({
      edgeId: edge.id,
      loopId: edge.loopId,
      loopKind: edge.loopKind,
      a: edge.a,
      b: edge.b,
      sourceTriangle: edge.sourceTriangle,
      edgeLength: distance(pa, pb),
      topEdgeLength: distance(paPrime, pbPrime),
      outwardNormal: outward,
      normalDeviationDeg: maxDeviation,
      problem: false,
      reasons: [],
      intersects: false,
      flipped,
      degenerate,
    });
  }

  // 三角形索引表 (实体全局顶点索引)
  const triangles: SolidTriangle[] = [];
  for (let t = 0; t < originalIndices.length; t += 3) {
    triangles.push({
      id: triangles.length,
      kind: 'original',
      a: originalIndices[t],
      b: originalIndices[t + 1],
      c: originalIndices[t + 2],
      sourceTriangle: t / 3,
      edgeId: -1,
    });
  }
  for (let t = 0; t < offsetIndices.length; t += 3) {
    triangles.push({
      id: triangles.length,
      kind: 'offset',
      a: offsetIndices[t],
      b: offsetIndices[t + 1],
      c: offsetIndices[t + 2],
      sourceTriangle: t / 3,
      edgeId: -1,
    });
  }
  for (let t = 0; t < sideIndices.length; t += 3) {
    const face = sideFaces[t / 3];
    triangles.push({
      id: triangles.length,
      kind: 'side',
      a: sideIndices[t],
      b: sideIndices[t + 1],
      c: sideIndices[t + 2],
      sourceTriangle: -1,
      edgeId: face.edgeId,
    });
  }

  const degenerate = options.thickness <= 1e-9;
  const validation = validateSolid(
    positions,
    triangles,
    sourceCount * 2,
    model,
    sideWalls,
    options,
    degenerate,
  );

  const volume = validation.topology.signedVolume;

  return {
    model,
    thickness: options.thickness,
    side: options.side,
    positions,
    originalIndices,
    offsetIndices,
    sideIndices,
    sideFaces,
    sideWalls,
    triangles,
    validation,
    sourceTriangleCount: sourceIndices.length / 3,
    vertexCount: sourceCount * 2,
    triangleCount: triangles.length,
    volume,
    degenerate,
    builtAt,
  };
}

interface TriangleAabb {
  min: Vec3;
  max: Vec3;
}

function computeAabb(positions: Float32Array, tri: SolidTriangle): TriangleAabb {
  const a = readVec3(positions, tri.a);
  const b = readVec3(positions, tri.b);
  const c = readVec3(positions, tri.c);
  return {
    min: [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])],
    max: [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])],
  };
}

function aabbOverlap(a: TriangleAabb, b: TriangleAabb, pad: number): boolean {
  return a.min[0] - pad <= b.max[0] && a.max[0] + pad >= b.min[0]
    && a.min[1] - pad <= b.max[1] && a.max[1] + pad >= b.min[1]
    && a.min[2] - pad <= b.max[2] && a.max[2] + pad >= b.min[2];
}

function sharedVertex(a: SolidTriangle, b: SolidTriangle): boolean {
  return a.a === b.a || a.a === b.b || a.a === b.c
    || a.b === b.a || a.b === b.b || a.b === b.c
    || a.c === b.a || a.c === b.b || a.c === b.c;
}

function kindPair(a: TriangleKind, b: TriangleKind): keyof IntersectionCounts {
  const order: Record<TriangleKind, number> = { original: 0, offset: 1, side: 2 };
  const [x, y] = order[a] <= order[b] ? [a, b] : [b, a];
  if (x === 'original' && y === 'original') return 'originalOriginal';
  if (x === 'original' && y === 'offset') return 'originalOffset';
  if (x === 'original' && y === 'side') return 'originalSide';
  if (x === 'offset' && y === 'offset') return 'offsetOffset';
  if (x === 'offset' && y === 'side') return 'offsetSide';
  return 'sideSide';
}

interface GridBucket {
  cells: Map<string, number[]>;
  cellSize: number;
}

function buildGrid(
  positions: Float32Array,
  triangles: SolidTriangle[],
  aabbs: TriangleAabb[],
): GridBucket {
  let edgeSum = 0;
  let edgeCount = 0;
  for (const tri of triangles) {
    edgeSum += distance(readVec3(positions, tri.a), readVec3(positions, tri.b));
    edgeSum += distance(readVec3(positions, tri.b), readVec3(positions, tri.c));
    edgeSum += distance(readVec3(positions, tri.c), readVec3(positions, tri.a));
    edgeCount += 3;
  }
  const avgEdge = edgeCount > 0 ? edgeSum / edgeCount : 0.1;
  const cellSize = Math.max(avgEdge * 2, 1e-4);
  const cells = new Map<string, number[]>();
  const maxCellsPerTriangle = 512;

  for (let i = 0; i < triangles.length; i++) {
    const box = aabbs[i];
    const x0 = Math.floor(box.min[0] / cellSize);
    const x1 = Math.floor(box.max[0] / cellSize);
    const y0 = Math.floor(box.min[1] / cellSize);
    const y1 = Math.floor(box.max[1] / cellSize);
    const z0 = Math.floor(box.min[2] / cellSize);
    const z1 = Math.floor(box.max[2] / cellSize);
    const span = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (span > maxCellsPerTriangle) {
      // 过大的三角形统一放进它最小角所在的格子, 兼顾覆盖与开销
      const key = `${x0}:${y0}:${z0}`;
      const list = cells.get(key);
      if (list) list.push(i);
      else cells.set(key, [i]);
      continue;
    }
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const key = `${x}:${y}:${z}`;
          const list = cells.get(key);
          if (list) list.push(i);
          else cells.set(key, [i]);
        }
      }
    }
  }
  return { cells, cellSize };
}

function intersectTrianglePairs(
  positions: Float32Array,
  triangles: SolidTriangle[],
): { issues: IntersectionIssue[]; total: number; truncated: boolean } {
  const aabbs = triangles.map((tri) => computeAabb(positions, tri));
  const grid = buildGrid(positions, triangles, aabbs);
  const seen = new Set<string>();
  const issues: IntersectionIssue[] = [];
  let total = 0;
  let truncated = false;

  for (const bucket of grid.cells.values()) {
    for (let i = 0; i < bucket.length; i++) {
      const ia = bucket[i];
      const ta = triangles[ia];
      for (let j = i + 1; j < bucket.length; j++) {
        const ib = bucket[j];
        const tb = triangles[ib];
        const low = ia < ib ? ia : ib;
        const high = ia < ib ? ib : ia;
        const key = `${low}:${high}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (sharedVertex(ta, tb)) continue;
        if (!aabbOverlap(aabbs[ia], aabbs[ib], 1e-9)) continue;

        const A: [Vec3, Vec3, Vec3] = [
          readVec3(positions, ta.a),
          readVec3(positions, ta.b),
          readVec3(positions, ta.c),
        ];
        const B: [Vec3, Vec3, Vec3] = [
          readVec3(positions, tb.a),
          readVec3(positions, tb.b),
          readVec3(positions, tb.c),
        ];
        const point = triangleTriangleIntersection(A, B);
        if (!point) continue;
        total++;
        if (issues.length >= MAX_REPORTED_INTERSECTIONS) {
          truncated = true;
          continue;
        }
        issues.push({
          a: ta.id,
          b: tb.id,
          aKind: ta.kind,
          bKind: tb.kind,
          aSourceTriangle: ta.sourceTriangle,
          bSourceTriangle: tb.sourceTriangle,
          aEdgeId: ta.edgeId,
          bEdgeId: tb.edgeId,
          point,
        });
      }
    }
  }
  return { issues, total, truncated };
}

function validateSolid(
  positions: Float32Array,
  triangles: SolidTriangle[],
  vertexCount: number,
  model: SurfaceModel,
  sideWalls: SideWallStatus[],
  options: SolidOptions,
  degenerate: boolean,
): ValidationReport {
  const indexTriples: IndexTriple[] = triangles.map((tri) => ({ a: tri.a, b: tri.b, c: tri.c }));
  const topology = analyzeTopology(positions, indexTriples, vertexCount);

  const foldedOffsetTriangles: FoldIssue[] = [];
  const problemSourceTriangles = new Set<number>();
  const degenerateSourceTriangles: number[] = [];

  for (const tri of triangles) {
    if (tri.kind !== 'offset') continue;
    const a = readVec3(positions, tri.a);
    const b = readVec3(positions, tri.b);
    const c = readVec3(positions, tri.c);
    const area = triangleArea(a, b, c);
    const sourceNormal = sourceTriangleNormal(model.positions, model.indices, tri.sourceTriangle);
    const expected: Vec3 = scale(sourceNormal, options.side);
    const actual = cross(sub(b, a), sub(c, a));
    const sourceArea = sourceTriangleArea(model, tri.sourceTriangle);
    const areaRatio = sourceArea > 1e-14 ? area / sourceArea : 0;
    const centroid: Vec3 = [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ];
    const cos = length(actual) > 1e-14 ? dot(normalize(actual), expected) : -1;
    const angleDeg = angleBetweenDeg(actual, expected);
    if (areaRatio < COLLAPSE_AREA_RATIO) {
      degenerateSourceTriangles.push(tri.sourceTriangle);
      foldedOffsetTriangles.push({
        triangle: tri.id,
        sourceTriangle: tri.sourceTriangle,
        angleDeg,
        areaRatio,
        reason: 'collapsed',
        centroid,
      });
      problemSourceTriangles.add(tri.sourceTriangle);
      continue;
    }
    if (cos <= FOLD_DOT_THRESHOLD) {
      foldedOffsetTriangles.push({
        triangle: tri.id,
        sourceTriangle: tri.sourceTriangle,
        angleDeg,
        areaRatio,
        reason: 'flipped',
        centroid,
      });
      problemSourceTriangles.add(tri.sourceTriangle);
    }
  }

  const { issues, total, truncated } = degenerate
    ? { issues: [] as IntersectionIssue[], total: 0, truncated: false }
    : intersectTrianglePairs(positions, triangles);

  const intersectionCounts: IntersectionCounts = {
    originalOriginal: 0,
    originalOffset: 0,
    originalSide: 0,
    offsetOffset: 0,
    offsetSide: 0,
    sideSide: 0,
  };
  const problemSideEdges = new Set<number>();

  for (const issue of issues) {
    intersectionCounts[kindPair(issue.aKind, issue.bKind)]++;
    if (issue.aKind !== 'side' && issue.aSourceTriangle >= 0) {
      problemSourceTriangles.add(issue.aSourceTriangle);
    }
    if (issue.bKind !== 'side' && issue.bSourceTriangle >= 0) {
      problemSourceTriangles.add(issue.bSourceTriangle);
    }
    if (issue.aKind === 'side' && issue.aEdgeId >= 0) problemSideEdges.add(issue.aEdgeId);
    if (issue.bKind === 'side' && issue.bEdgeId >= 0) problemSideEdges.add(issue.bEdgeId);
  }

  // 侧壁状态汇总: 翻转/退化/与其它面相交
  for (const wall of sideWalls) {
    const reasons: string[] = [];
    if (wall.flipped) reasons.push('侧壁法线翻转, 该段边界已折回');
    if (wall.degenerate) reasons.push('侧壁三角形退化 (面积趋近 0)');
    if (wall.topEdgeLength < wall.edgeLength * 0.02) reasons.push('偏移后边界长度坍缩');
    wall.intersects = problemSideEdges.has(wall.edgeId);
    if (wall.intersects) reasons.push('侧壁与其它面相交');
    wall.problem = reasons.length > 0;
    wall.reasons = reasons;
  }

  const degenerateSideEdges = sideWalls
    .filter((wall) => wall.degenerate || wall.flipped)
    .map((wall) => wall.edgeId);
  for (const edgeId of problemSideEdges) {
    if (!degenerateSideEdges.includes(edgeId)) degenerateSideEdges.push(edgeId);
  }

  const messages: string[] = [];
  if (degenerate) {
    messages.push('厚度为 0: 偏移层与原始层重合, 实体退化, 不检查自相交。');
  }
  if (!topology.closed) {
    messages.push(
      topology.boundaryEdgeCount === 0
        ? '实体未闭合: 存在不一致的有向边。'
        : `实体未闭合: 仍有 ${topology.boundaryEdgeCount} 条边只被一个三角形使用。`,
    );
  }
  if (!topology.manifold) {
    messages.push(
      `存在非流形边 ${topology.nonManifoldEdgeCount} 条, 绕序不一致边 ${topology.inconsistentEdgeCount} 条。`,
    );
  }
  if (topology.degenerateTriangleCount > 0) {
    messages.push(`${topology.degenerateTriangleCount} 个三角形面积为 0。`);
  }
  if (!topology.orientationPositive && !degenerate) {
    messages.push('实体有符号体积为负, 整体绕序可能朝内。');
  }
  if (foldedOffsetTriangles.length > 0) {
    const flipped = foldedOffsetTriangles.filter((item) => item.reason === 'flipped').length;
    const collapsed = foldedOffsetTriangles.length - flipped;
    messages.push(
      `偏移层有 ${foldedOffsetTriangles.length} 个三角形异常 (反折 ${flipped}, 坍缩 ${collapsed})。`,
    );
  }
  if (total > 0) {
    messages.push(`检测到 ${total} 处三角形互相穿插${truncated ? ' (列表已截断)' : ''}。`);
    if (intersectionCounts.offsetOffset > 0) {
      messages.push(`其中偏移层自相交 ${intersectionCounts.offsetOffset} 处, 即"另一面网格插出来"。`);
    }
  }

  const valid = !degenerate
    && topology.closed
    && topology.manifold
    && topology.degenerateTriangleCount === 0
    && foldedOffsetTriangles.length === 0
    && total === 0
    && topology.orientationPositive;

  if (valid) messages.push('实体闭合、流形、无自相交, 通过检查。');

  return {
    topology,
    foldedOffsetTriangles,
    intersections: issues,
    intersectionTotal: total,
    intersectionsTruncated: truncated,
    problemSourceTriangles,
    problemSideEdges,
    intersectionCounts,
    degenerateSourceTriangles,
    degenerateSideEdges,
    valid,
    messages,
  };
}

function sourceTriangleArea(model: SurfaceModel, triangle: number): number {
  const ia = model.indices[triangle * 3];
  const ib = model.indices[triangle * 3 + 1];
  const ic = model.indices[triangle * 3 + 2];
  return triangleArea(
    readVec3(model.positions, ia),
    readVec3(model.positions, ib),
    readVec3(model.positions, ic),
  );
}

/** 侧壁三角形在 sideIndices 中的序号 -> 原始边界边 */
export function sideTriangleToEdge(solid: ThickenedSolid, sideTriangleIndex: number): SideFaceMeta | null {
  if (sideTriangleIndex < 0 || sideTriangleIndex >= solid.sideFaces.length) return null;
  return solid.sideFaces[sideTriangleIndex];
}
