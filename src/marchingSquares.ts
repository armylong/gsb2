/**
 * Marching Squares：在二维采样场上提取等值线（切片上的"阈值截线"）。
 * 输入为规则二维网格（u 最快），输出 2D 线段（世界坐标 u/v）。
 */

export interface Segment2 {
  au: number; av: number;
  bu: number; bv: number;
}

export function marchingSquares(
  values: Float32Array,
  nu: number,
  nv: number,
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
  iso: number,
): Segment2[] {
  const hu = (uMax - uMin) / (nu - 1);
  const hv = (vMax - vMin) / (nv - 1);
  const segments: Segment2[] = [];
  const at = (i: number, j: number) => values[i + nu * j];

  // 单元四角: 0=(i,j) 1=(i+1,j) 2=(i+1,j+1) 3=(i,j+1)
  // 边: 0: 0-1(下) 1: 1-2(右) 2: 2-3(上) 3: 3-0(左)
  const interp = (va: number, vb: number) => (iso - va) / (vb - va);

  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const v0 = at(i, j);
      const v1 = at(i + 1, j);
      const v2 = at(i + 1, j + 1);
      const v3 = at(i, j + 1);
      let code = 0;
      if (v0 < iso) code |= 1;
      if (v1 < iso) code |= 2;
      if (v2 < iso) code |= 4;
      if (v3 < iso) code |= 8;
      if (code === 0 || code === 15) continue;

      const u0 = uMin + i * hu;
      const v0w = vMin + j * hv;
      // 各边交点（按需计算）
      const pt = (edge: number): [number, number] => {
        switch (edge) {
          case 0: { const t = interp(v0, v1); return [u0 + t * hu, v0w]; }
          case 1: { const t = interp(v1, v2); return [u0 + hu, v0w + t * hv]; }
          case 2: { const t = interp(v3, v2); return [u0 + t * hu, v0w + hv]; }
          default: { const t = interp(v0, v3); return [u0, v0w + t * hv]; }
        }
      };
      // 查表：每种情形用到的边对
      const TABLE: Record<number, [number, number][]> = {
        1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]],
        4: [[1, 2]], 5: [[3, 0], [1, 2]], 6: [[0, 2]], 7: [[3, 2]],
        8: [[2, 3]], 9: [[2, 0]], 10: [[0, 1], [2, 3]], 11: [[2, 1]],
        12: [[1, 3]], 13: [[1, 0]], 14: [[0, 3]],
      };
      for (const [e1, e2] of TABLE[code] ?? []) {
        const [au, av] = pt(e1);
        const [bu, bv] = pt(e2);
        segments.push({ au, av, bu, bv });
      }
    }
  }
  return segments;
}
