import type { BoundaryEdge, BoundaryLoop, SurfaceModel, Vec3 } from './types';
import {
  boundsFromPositions,
  cross,
  dot,
  hashMesh,
  length,
  normalize,
  sub,
} from './vec';

export interface RawSurfaceInput {
  id: string;
  name: string;
  subtitle: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** +1 表示顶点法线正侧是凹侧 */
  concaveSide: 1 | -1;
  defaultThickness: number;
  maxThickness: number;
  notes?: string[];
}

interface DirectedEdge {
  a: number;
  b: number;
  triangle: number;
}

function vertex(positions: Float32Array, index: number): Vec3 {
  return [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
}

/** 角度加权顶点法线。绕序决定法线朝向, 生成器会先统一绕序再调用。 */
export function computeVertexNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t];
    const ib = indices[t + 1];
    const ic = indices[t + 2];
    const a = vertex(positions, ia);
    const b = vertex(positions, ib);
    const c = vertex(positions, ic);
    const n = normalize(cross(sub(b, a), sub(c, a)));
    const corners: Array<[number, number, number]> = [
      [ia, ib, ic],
      [ib, ic, ia],
      [ic, ia, ib],
    ];
    for (const [self, next, prev] of corners) {
      const p = vertex(positions, self);
      const angle = Math.acos(
        Math.min(1, Math.max(-1, dot(normalize(sub(vertex(positions, next), p)), normalize(sub(vertex(positions, prev), p))))),
      );
      normals[self * 3] += n[0] * angle;
      normals[self * 3 + 1] += n[1] * angle;
      normals[self * 3 + 2] += n[2] * angle;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const n = normalize([normals[i], normals[i + 1], normals[i + 2]]);
    normals[i] = n[0];
    normals[i + 1] = n[1];
    normals[i + 2] = n[2];
  }
  return normals;
}

/**
 * 只被一个三角形使用的有向边。方向沿用它在源三角形中的绕序,
 * 链成环后每条边方向与源网格绕序一致, 侧壁朝向才与曲面一致。
 */
export function collectBoundaryEdges(indices: Uint32Array): DirectedEdge[] {
  const uses = new Map<string, { count: number; a: number; b: number; triangle: number }>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k];
      const b = indices[t + ((k + 1) % 3)];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const existing = uses.get(key);
      if (existing) existing.count++;
      else uses.set(key, { count: 1, a, b, triangle: t / 3 });
    }
  }
  const boundary: DirectedEdge[] = [];
  for (const use of uses.values()) {
    if (use.count === 1) boundary.push({ a: use.a, b: use.b, triangle: use.triangle });
  }
  return boundary;
}

/** 把边界有向边串成环, 面积最大者标记为外缘, 其余为原始孔洞 */
export function findBoundaryLoops(
  positions: Float32Array,
  indices: Uint32Array,
): { loops: BoundaryLoop[]; edges: BoundaryEdge[] } {
  const boundary = collectBoundaryEdges(indices);
  const byStart = new Map<number, DirectedEdge[]>();
  for (const edge of boundary) {
    const list = byStart.get(edge.a);
    if (list) list.push(edge);
    else byStart.set(edge.a, [edge]);
  }

  const used = new Set<DirectedEdge>();
  const loops: BoundaryLoop[] = [];
  const edges: BoundaryEdge[] = [];

  for (const first of boundary) {
    if (used.has(first)) continue;
    const chain: DirectedEdge[] = [];
    let current: DirectedEdge | undefined = first;
    let guard = 0;
    while (current && guard++ <= boundary.length + 1) {
      if (used.has(current)) break;
      used.add(current);
      chain.push(current);
      if (current.b === first.a) break;
      current = byStart.get(current.b)?.find((edge) => !used.has(edge));
    }
    const closed = chain.length >= 3 && chain[chain.length - 1].b === first.a;
    if (!closed) continue;

    const vertices = chain.map((edge) => edge.a);
    const loopId = loops.length;

    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < vertices.length; i++) {
      const p = vertices[i];
      const q = vertices[(i + 1) % vertices.length];
      nx += positions[p * 3] * positions[q * 3 + 1] - positions[q * 3] * positions[p * 3 + 1];
      ny += positions[p * 3 + 1] * positions[q * 3 + 2] - positions[q * 3 + 1] * positions[p * 3 + 2];
      nz += positions[p * 3 + 2] * positions[q * 3] - positions[q * 3 + 2] * positions[p * 3];
    }
    const ref = chain[0].triangle * 3;
    const refNormal = normalize(cross(
      sub(vertex(positions, indices[ref + 1]), vertex(positions, indices[ref])),
      sub(vertex(positions, indices[ref + 2]), vertex(positions, indices[ref])),
    ));
    // Newell 向量长度 = 2*面积, 与单位参考法线点积得到带符号面积
    const signedArea = 0.5 * dot([nx, ny, nz], refNormal);
    let perimeter = 0;
    for (let i = 0; i < chain.length; i++) {
      const item = chain[i];
      const len = length(sub(vertex(positions, item.b), vertex(positions, item.a)));
      perimeter += len;
      edges.push({
        id: edges.length,
        loopId,
        loopKind: 'hole',
        a: item.a,
        b: item.b,
        sourceTriangle: item.triangle,
        length: len,
      });
    }
    loops.push({
      id: loopId,
      kind: 'hole',
      vertices,
      signedArea,
      perimeter,
    });
  }

  if (loops.length > 0) {
    let outer = loops[0];
    for (const loop of loops) {
      if (Math.abs(loop.signedArea) > Math.abs(outer.signedArea)) outer = loop;
    }
    outer.kind = 'outer';
    for (const edge of edges) if (edge.loopId === outer.id) edge.loopKind = 'outer';
  }
  return { loops, edges };
}

export function createSurfaceModel(input: RawSurfaceInput): SurfaceModel {
  const positions = input.positions.slice();
  const indices = input.indices.slice();
  const vertexCount = positions.length / 3;
  if (positions.length % 3 !== 0) throw new Error('顶点数组长度不是 3 的倍数');
  if (indices.length % 3 !== 0) throw new Error('索引数组长度不是 3 的倍数');
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertexCount) {
      throw new Error(`索引 ${indices[i]} 超出顶点数 ${vertexCount}`);
    }
  }
  const normals = computeVertexNormals(positions, indices);
  const { loops, edges } = findBoundaryLoops(positions, indices);
  if (loops.length === 0) throw new Error('曲面片没有边界, 无法作为开口纸罩加厚');
  return {
    id: input.id,
    name: input.name,
    subtitle: input.subtitle,
    positions,
    indices,
    normals,
    boundaries: loops,
    boundaryEdges: edges,
    concaveSide: input.concaveSide,
    defaultThickness: input.defaultThickness,
    maxThickness: input.maxThickness,
    bounds: boundsFromPositions(positions),
    sourceHash: hashMesh(positions, indices),
    notes: input.notes ?? [],
  };
}

export function sourceTriangleNormal(
  positions: Float32Array,
  indices: Uint32Array,
  triangle: number,
): Vec3 {
  const ia = indices[triangle * 3];
  const ib = indices[triangle * 3 + 1];
  const ic = indices[triangle * 3 + 2];
  return normalize(cross(
    sub(vertex(positions, ib), vertex(positions, ia)),
    sub(vertex(positions, ic), vertex(positions, ia)),
  ));
}

export function sourceTriangleCentroid(
  positions: Float32Array,
  indices: Uint32Array,
  triangle: number,
): Vec3 {
  const ia = indices[triangle * 3];
  const ib = indices[triangle * 3 + 1];
  const ic = indices[triangle * 3 + 2];
  return [
    (positions[ia * 3] + positions[ib * 3] + positions[ic * 3]) / 3,
    (positions[ia * 3 + 1] + positions[ib * 3 + 1] + positions[ic * 3 + 1]) / 3,
    (positions[ia * 3 + 2] + positions[ib * 3 + 2] + positions[ic * 3 + 2]) / 3,
  ];
}
