import type { PointCloud } from './scenes';

export interface OverlapResult {
  /** 与 statsActive 对齐: 该点所在屏幕格的视线方向深度跨度 */
  spreads: Float32Array;
  /** 与 statsActive 对齐: 深度跨度 > depthGap 即判为投影重叠 */
  isOverlap: Uint8Array;
  overlapPointFraction: number;
  totalBins: number;
  overlapBins: number;
  binSize: number;
  depthGap: number;
  direction: [number, number, number];
}

/**
 * 沿给定视线方向做正交投影, 在垂直平面上分格统计:
 * 同一屏幕格内若沿视线的深度跨度超过 depthGap, 说明多个深度不同的结构
 * 在该视线上重叠 (投影重叠), 旋转视角即可分开。
 */
export function analyzeProjection(
  cloud: PointCloud,
  active: Uint32Array,
  direction: [number, number, number],
  binSize: number,
  depthGap: number,
): OverlapResult {
  const len = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const d = [direction[0] / len, direction[1] / len, direction[2] / len];
  // 构造垂直于视线的正交基 u, v
  const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize(cross(ref, d));
  const v = cross(d, u);

  const pos = cloud.positions;
  const binMin = new Map<number, number>();
  const binMax = new Map<number, number>();
  const binKeyOf = new Int32Array(cloud.count).fill(-1);
  const key = (a: number, b: number) => (a + 4096) * 8192 + (b + 4096);

  for (let k = 0; k < active.length; k++) {
    const i = active[k];
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const depth = d[0] * x + d[1] * y + d[2] * z;
    const cu = Math.floor((u[0] * x + u[1] * y + u[2] * z) / binSize);
    const cv = Math.floor((v[0] * x + v[1] * y + v[2] * z) / binSize);
    const bk = key(cu, cv);
    binKeyOf[i] = bk;
    const prevMin = binMin.get(bk);
    if (prevMin === undefined || depth < prevMin) binMin.set(bk, depth);
    const prevMax = binMax.get(bk);
    if (prevMax === undefined || depth > prevMax) binMax.set(bk, depth);
  }

  const spreads = new Float32Array(active.length);
  const isOverlap = new Uint8Array(active.length);
  let overlapPts = 0;
  const overlapBins = new Set<number>();
  for (let k = 0; k < active.length; k++) {
    const bk = binKeyOf[active[k]];
    const spread = (binMax.get(bk) ?? 0) - (binMin.get(bk) ?? 0);
    spreads[k] = spread;
    if (spread > depthGap) {
      isOverlap[k] = 1;
      overlapPts++;
      overlapBins.add(bk);
    }
  }
  return {
    spreads,
    isOverlap,
    overlapPointFraction: active.length ? overlapPts / active.length : 0,
    totalBins: binMin.size,
    overlapBins: overlapBins.size,
    binSize,
    depthGap,
    direction: [d[0], d[1], d[2]],
  };
}

function cross(a: number[], b: number[]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function normalize(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
