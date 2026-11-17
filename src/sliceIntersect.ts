/**
 * 网格与轴对齐平面的求交，输出世界坐标线段（用于切片对照显示）。
 */

import type { Mesh } from './marchingTets';

export type Axis = 'x' | 'y' | 'z';

export interface Segment3 {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
}

/** 计算网格与 plane(axis, pos) 的交线段集合。 */
export function intersectMeshPlane(mesh: Mesh, axis: Axis, pos: number): Segment3[] {
  const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const p = mesh.positions;
  const idx = mesh.indices;
  const segments: Segment3[] = [];
  const eps = 1e-9;

  for (let t = 0; t < idx.length; t += 3) {
    const pts: number[][] = [];
    for (let e = 0; e < 3; e++) {
      const va = idx[t + e] * 3;
      const vb = idx[t + ((e + 1) % 3)] * 3;
      const da = p[va + ai] - pos;
      const db = p[vb + ai] - pos;
      if (da * db < -eps * eps || (da * db < 0)) {
        const tt = da / (da - db);
        pts.push([
          p[va] + tt * (p[vb] - p[va]),
          p[va + 1] + tt * (p[vb + 1] - p[va + 1]),
          p[va + 2] + tt * (p[vb + 2] - p[va + 2]),
        ]);
      } else if (Math.abs(da) <= eps && Math.abs(db) > eps) {
        // 顶点恰好落在平面上
        pts.push([p[va], p[va + 1], p[va + 2]]);
      }
    }
    // 去重（顶点落平面时可能重复）
    const uniq: number[][] = [];
    for (const q of pts) {
      if (!uniq.some((u) => Math.hypot(u[0] - q[0], u[1] - q[1], u[2] - q[2]) < 1e-7)) uniq.push(q);
    }
    if (uniq.length === 2) {
      segments.push({
        ax: uniq[0][0], ay: uniq[0][1], az: uniq[0][2],
        bx: uniq[1][0], by: uniq[1][1], bz: uniq[1][2],
      });
    } else if (uniq.length > 2) {
      // 罕见（三角形与平面共面边等），取最远两点
      let best: [number[], number[]] | null = null;
      let bestD = -1;
      for (let ii = 0; ii < uniq.length; ii++) {
        for (let jj = ii + 1; jj < uniq.length; jj++) {
          const d = Math.hypot(uniq[ii][0] - uniq[jj][0], uniq[ii][1] - uniq[jj][1], uniq[ii][2] - uniq[jj][2]);
          if (d > bestD) { bestD = d; best = [uniq[ii], uniq[jj]]; }
        }
      }
      if (best) {
        segments.push({ ax: best[0][0], ay: best[0][1], az: best[0][2], bx: best[1][0], by: best[1][1], bz: best[1][2] });
      }
    }
  }
  return segments;
}
