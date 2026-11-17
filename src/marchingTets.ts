/**
 * Marching Tetrahedra 等值面提取。
 *
 * 选择四面体而非立方体查表的原因：只有 16 种情形、无歧义面，
 * 朝向规则简单可验证（法线恒指向场值增大的一侧，即 SDF 外部），
 * 便于保证"阈值、坐标、朝向、导出"四处一致。
 *
 * 每个立方体单元沿主对角线 (0,0,0)-(1,1,1) 分解为 6 个四面体，
 * 相邻单元的公共面剖分一致，不会产生裂缝。
 *
 * 顶点按全局边（两个网格点 id 对）去重，输出索引网格。
 */

import type { Grid } from './field';

export interface Mesh {
  /** 世界坐标顶点，xyz 连续排列 */
  positions: Float32Array;
  /** 单位法线（由三角形面积加权累积，指向 SDF 外部） */
  normals: Float32Array;
  /** 三角形索引 */
  indices: Uint32Array;
  triangleCount: number;
  vertexCount: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
}

// 立方体 8 角的局部偏移（与 field.ts 的下标约定一致：x 最快）
const CORNER_DI = [0, 1, 1, 0, 0, 1, 1, 0];
const CORNER_DJ = [0, 0, 1, 1, 0, 0, 1, 1];
const CORNER_DK = [0, 0, 0, 0, 1, 1, 1, 1];

// 6 个四面体（立方体角编号），均含主对角线 0-6
const TETS: [number, number, number, number][] = [
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
  [0, 5, 1, 6],
];

// 四面体 6 条边的端点（四面体内局部编号 0..3）
const TET_EDGES: [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];

export function extractIsosurface(grid: Grid, iso: number): Mesh {
  const n = grid.n;
  const values = grid.values;
  const h = grid.h;
  const [mx, my, mz] = grid.min;

  const positions: number[] = [];
  const indices: number[] = [];
  // 全局边 -> 顶点下标。边用两端网格点全局 id 表示（小 id * 2^20 + 大 id）。
  const edgeVertex = new Map<number, number>();

  const cornerX = new Float64Array(8);
  const cornerY = new Float64Array(8);
  const cornerZ = new Float64Array(8);
  const cornerVal = new Float32Array(8);
  const cornerId = new Int32Array(8);

  function edgeVertexIndex(aId: number, ax: number, ay: number, az: number, av: number,
                           bId: number, bx: number, by: number, bz: number, bv: number): number {
    const lo = Math.min(aId, bId);
    const hi = Math.max(aId, bId);
    const key = lo * 1048576 + hi;
    const cached = edgeVertex.get(key);
    if (cached !== undefined) return cached;
    const t = (iso - av) / (bv - av);
    const idx = positions.length / 3;
    positions.push(ax + t * (bx - ax), ay + t * (by - ay), az + t * (bz - az));
    edgeVertex.set(key, idx);
    return idx;
  }

  // 用"内部点"修正三角形朝向：法线必须背离内部（指向 SDF 外部）
  function emitTriangle(a: number, b: number, c: number, inX: number, inY: number, inZ: number) {
    const p = positions;
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2];
    const cx = p[c * 3], cy = p[c * 3 + 1], cz = p[c * 3 + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const gx = (ax + bx + cx) / 3 - inX;
    const gy = (ay + by + cy) / 3 - inY;
    const gz = (az + bz + cz) / 3 - inZ;
    if (nx * gx + ny * gy + nz * gz < 0) {
      indices.push(a, c, b);
    } else {
      indices.push(a, b, c);
    }
  }

  for (let k = 0; k < n - 1; k++) {
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        for (let c = 0; c < 8; c++) {
          const ci = i + CORNER_DI[c];
          const cj = j + CORNER_DJ[c];
          const ck = k + CORNER_DK[c];
          cornerX[c] = mx + ci * h;
          cornerY[c] = my + cj * h;
          cornerZ[c] = mz + ck * h;
          cornerVal[c] = values[ci + n * (cj + n * ck)];
          cornerId[c] = ci + n * (cj + n * ck);
        }
        for (const tet of TETS) {
          // 收集四面体 4 顶点
          const inside: number[] = [];
          const outside: number[] = [];
          for (let v = 0; v < 4; v++) {
            (cornerVal[tet[v]] < iso ? inside : outside).push(v);
          }
          if (inside.length === 0 || inside.length === 4) continue;

          // 计算 6 条边中跨越等值面的交点（按需）
          const ev = new Array<number>(6).fill(-1);
          const edgeIdx = (e: number): number => {
            if (ev[e] >= 0) return ev[e];
            const [ta, tb] = TET_EDGES[e];
            const ca = tet[ta];
            const cb = tet[tb];
            const idx = edgeVertexIndex(
              cornerId[ca], cornerX[ca], cornerY[ca], cornerZ[ca], cornerVal[ca],
              cornerId[cb], cornerX[cb], cornerY[cb], cornerZ[cb], cornerVal[cb],
            );
            ev[e] = idx;
            return idx;
          };
          // 边编号辅助：TET_EDGES 中 (a,b) 的序号
          const E = (a: number, b: number): number => {
            for (let e = 0; e < 6; e++) {
              const [ta, tb] = TET_EDGES[e];
              if ((ta === a && tb === b) || (ta === b && tb === a)) return e;
            }
            throw new Error('bad edge');
          };

          if (inside.length === 1 || inside.length === 3) {
            const inV = inside.length === 1 ? inside[0] : -1;
            const outV = inside.length === 3 ? outside[0] : -1;
            const lone = inside.length === 1 ? inV : outV;
            const others = inside.length === 1 ? outside : inside;
            const p0 = edgeIdx(E(lone, others[0]));
            const p1 = edgeIdx(E(lone, others[1]));
            const p2 = edgeIdx(E(lone, others[2]));
            // 内部参考点：内部顶点（们）的平均位置
            let rx = 0, ry = 0, rz = 0;
            const ref = inside.length === 1 ? inside : inside;
            for (const iv of ref) {
              rx += cornerX[tet[iv]]; ry += cornerY[tet[iv]]; rz += cornerZ[tet[iv]];
            }
            rx /= ref.length; ry /= ref.length; rz /= ref.length;
            emitTriangle(p0, p1, p2, rx, ry, rz);
          } else {
            // 2 内 2 外：四边形 (A-C, B-C, B-D, A-D)，A,B 内；C,D 外
            const [A, B] = inside;
            const [C, D] = outside;
            const ac = edgeIdx(E(A, C));
            const bc = edgeIdx(E(B, C));
            const bd = edgeIdx(E(B, D));
            const ad = edgeIdx(E(A, D));
            const rx = (cornerX[tet[A]] + cornerX[tet[B]]) / 2;
            const ry = (cornerY[tet[A]] + cornerY[tet[B]]) / 2;
            const rz = (cornerZ[tet[A]] + cornerZ[tet[B]]) / 2;
            emitTriangle(ac, bc, bd, rx, ry, rz);
            emitTriangle(ac, bd, ad, rx, ry, rz);
          }
        }
      }
    }
  }

  const posArr = new Float32Array(positions);
  const idxArr = new Uint32Array(indices);
  const normals = computeNormals(posArr, idxArr);

  const boundsMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const boundsMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < posArr.length; v += 3) {
    for (let a = 0; a < 3; a++) {
      const val = posArr[v + a];
      if (val < boundsMin[a]) boundsMin[a] = val;
      if (val > boundsMax[a]) boundsMax[a] = val;
    }
  }
  if (posArr.length === 0) {
    boundsMin[0] = boundsMin[1] = boundsMin[2] = 0;
    boundsMax[0] = boundsMax[1] = boundsMax[2] = 0;
  }

  return {
    positions: posArr,
    normals,
    indices: idxArr,
    triangleCount: idxArr.length / 3,
    vertexCount: posArr.length / 3,
    boundsMin,
    boundsMax,
  };
}

/** 面积加权顶点法线。 */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const v of [a, b, c]) {
      normals[v] += nx;
      normals[v + 1] += ny;
      normals[v + 2] += nz;
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const len = Math.hypot(normals[v], normals[v + 1], normals[v + 2]);
    if (len > 0) {
      normals[v] /= len;
      normals[v + 1] /= len;
      normals[v + 2] /= len;
    }
  }
  return normals;
}

/** 有符号体积（外朝向闭合网格为正）。用于验证表面朝向。 */
export function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let vol = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

/** 统计只被一个三角形使用的边数（>0 说明网格有开口，如边界截断）。 */
export function countBoundaryEdges(indices: Uint32Array): number {
  const edgeCount = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const c of edgeCount.values()) if (c === 1) open++;
  return open;
}
