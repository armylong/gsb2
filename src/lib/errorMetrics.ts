/**
 * 简化网格 -> 原始表面的距离误差度量。
 *
 * 采样规则（固定、可复现，不随颜色范围或交互改变）：
 *   1. 简化网格的每个顶点；
 *   2. 简化网格每个三角形的形心。
 * 对每个采样点，用 three-mesh-bvh 在原始网格上求最近点，取欧氏距离。
 * 输出最大距离 max 与均方根 RMS = sqrt(mean(d^2))。
 *
 * 这是“采样误差”，不是严格全局上界：未采样位置可能存在更大偏差，
 * 形心采样也不保证落在偏差极值上。UI 必须明确标注这一点。
 * 颜色映射范围（colorRange）只影响显示，不参与读数计算。
 */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
export { MeshBVH };
import { MeshData, triangleCount, vertexCount } from './meshTypes';

export interface ErrorMetrics {
  /** 采样点总数（简化顶点数 + 简化三角形数） */
  sampleCount: number;
  max: number;
  rms: number;
  mean: number;
  /** 每个采样点的距离，顺序：先全部顶点，再全部三角形形心 */
  distances: Float32Array;
  /** 采样点在简化网格本地坐标下的位置（与 distances 一一对应） */
  samplePoints: Float32Array;
}

export function buildBVH(mesh: MeshData): MeshBVH {
  const geometry = toThreeGeometry(mesh);
  geometry.computeVertexNormals();
  return new MeshBVH(geometry, { targetLeafSize: 4 });
}

export function toThreeGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  return geometry;
}

/**
 * 计算 simplified 上的固定采样点到 original 表面的距离。
 * originalBVH 由调用方构建并复用（原始网格在多次简化间不变）。
 */
export function computeSampledError(
  simplified: MeshData,
  originalBVH: MeshBVH,
): ErrorMetrics {
  const nVerts = vertexCount(simplified);
  const nTris = triangleCount(simplified);
  const sampleCount = nVerts + nTris;
  const distances = new Float32Array(sampleCount);
  const samplePoints = new Float32Array(sampleCount * 3);

  const point = new THREE.Vector3();
  let sum = 0;
  let sumSq = 0;
  let max = 0;

  const measure = (sampleIndex: number, x: number, y: number, z: number) => {
    point.set(x, y, z);
    samplePoints[sampleIndex * 3] = x;
    samplePoints[sampleIndex * 3 + 1] = y;
    samplePoints[sampleIndex * 3 + 2] = z;
    const hit = originalBVH.closestPointToPoint(point);
    // 原始网格非空时 BVH 必返回命中；防御性兜底
    const d = hit ? hit.distance : 0;
    distances[sampleIndex] = d;
    sum += d;
    sumSq += d * d;
    if (d > max) max = d;
  };

  // 规则 1：全部顶点
  for (let v = 0; v < nVerts; v++) {
    measure(
      v,
      simplified.positions[v * 3],
      simplified.positions[v * 3 + 1],
      simplified.positions[v * 3 + 2],
    );
  }
  // 规则 2：全部三角形形心
  const idx = simplified.indices;
  const pos = simplified.positions;
  for (let t = 0; t < nTris; t++) {
    const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
    const cx = (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3;
    const cy = (pos[i0 * 3 + 1] + pos[i1 * 3 + 1] + pos[i2 * 3 + 1]) / 3;
    const cz = (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3;
    measure(nVerts + t, cx, cy, cz);
  }

  return {
    sampleCount,
    max,
    rms: Math.sqrt(sumSq / sampleCount),
    mean: sum / sampleCount,
    distances,
    samplePoints,
  };
}

/**
 * 把采样距离着色到简化网格顶点上。
 * 每个顶点先取其顶点采样距离，再累加相邻面形心距离做平均，
 * 这样面内偏差也能在颜色上体现，而不是只有顶点位置变色。
 * range 是颜色映射上限（仅影响颜色，不影响 metrics 读数）；超出范围的钳为红色。
 */
export function buildDistanceColors(
  simplified: MeshData,
  metrics: ErrorMetrics,
  range: number,
): THREE.BufferAttribute {
  const nVerts = vertexCount(simplified);
  const nTris = triangleCount(simplified);
  const accumulated = new Float64Array(nVerts);
  const weight = new Float32Array(nVerts);

  for (let v = 0; v < nVerts; v++) {
    accumulated[v] += metrics.distances[v];
    weight[v] += 1;
  }
  const idx = simplified.indices;
  for (let t = 0; t < nTris; t++) {
    const centroidDistance = metrics.distances[nVerts + t];
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      accumulated[v] += centroidDistance;
      weight[v] += 1;
    }
  }

  const colors = new Float32Array(nVerts * 3);
  const color = new THREE.Color();
  const safeRange = range > 0 ? range : 1;
  for (let v = 0; v < nVerts; v++) {
    const distance = accumulated[v] / weight[v];
    const clamped = Math.min(1, Math.max(0, distance / safeRange));
    colormap(clamped, color);
    colors[v * 3] = color.r;
    colors[v * 3 + 1] = color.g;
    colors[v * 3 + 2] = color.b;
  }
  return new THREE.BufferAttribute(colors, 3);
}

/**
 * 蓝 → 青 → 绿 → 黄 → 红 的连续顺序色带（距离 0 -> 大）。
 * 与 UI 面板上的色阶条使用同一函数。
 */
export function colormap(t: number, target: THREE.Color): THREE.Color {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [0.16, 0.38, 0.9]], // 蓝
    [0.25, [0.1, 0.75, 0.85]], // 青
    [0.5, [0.18, 0.72, 0.32]], // 绿
    [0.75, [0.95, 0.78, 0.15]], // 黄
    [1.0, [0.85, 0.18, 0.16]], // 红
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const k = (t - t0) / (t1 - t0);
      target.setRGB(
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      );
      return target;
    }
  }
  const last = stops[stops.length - 1][1];
  target.setRGB(last[0], last[1], last[2]);
  return target;
}

/** 单点最近点查询（点击检查用）。返回原表面上的最近点、所在面与距离。 */
export function nearestPointOnOriginal(
  point: THREE.Vector3,
  originalBVH: MeshBVH,
): { point: THREE.Vector3; faceIndex: number; distance: number } | null {
  const hit = originalBVH.closestPointToPoint(point);
  if (!hit) return null;
  return {
    point: hit.point.clone(),
    faceIndex: hit.faceIndex ?? -1,
    distance: hit.distance,
  };
}
