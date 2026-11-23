import type { SurfaceModel } from './types';

export interface Adjacency {
  /** 每个三角形最多 3 个邻接三角形 */
  neighbors: number[][];
  triangleCount: number;
}

export function buildAdjacency(model: SurfaceModel): Adjacency {
  const triangleCount = model.indices.length / 3;
  const edgeToTriangles = new Map<string, number[]>();
  for (let t = 0; t < model.indices.length; t += 3) {
    const tri = t / 3;
    for (let k = 0; k < 3; k++) {
      const a = model.indices[t + k];
      const b = model.indices[t + ((k + 1) % 3)];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const list = edgeToTriangles.get(key);
      if (list) list.push(tri);
      else edgeToTriangles.set(key, [tri]);
    }
  }
  const neighbors: number[][] = Array.from({ length: triangleCount }, () => []);
  for (const list of edgeToTriangles.values()) {
    if (list.length !== 2) continue;
    const [a, b] = list;
    neighbors[a].push(b);
    neighbors[b].push(a);
  }
  return { neighbors, triangleCount };
}

const adjacencyCache = new Map<string, Adjacency>();

export function getAdjacency(model: SurfaceModel): Adjacency {
  let cached = adjacencyCache.get(model.sourceHash);
  if (!cached) {
    cached = buildAdjacency(model);
    adjacencyCache.set(model.sourceHash, cached);
  }
  return cached;
}

/**
 * 以种子三角形为中心, 按共享边的区域生长 rings 圈。
 * 用于"选一块区域检查局部厚度和法线"。
 */
export function growRegion(model: SurfaceModel, seeds: number[], rings: number): number[] {
  const adjacency = getAdjacency(model);
  const visited = new Set<number>();
  let frontier: number[] = [];
  for (const seed of seeds) {
    if (seed >= 0 && seed < adjacency.triangleCount && !visited.has(seed)) {
      visited.add(seed);
      frontier.push(seed);
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    const next: number[] = [];
    for (const triangle of frontier) {
      for (const neighbor of adjacency.neighbors[triangle]) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return [...visited].sort((a, b) => a - b);
}

/** 找到离给定点最近的源三角形, 用于按世界坐标选区域 */
export function nearestTriangle(model: SurfaceModel, point: [number, number, number], maxDistance = Infinity): number | null {
  let best = -1;
  let bestDistance = maxDistance;
  for (let t = 0; t < model.indices.length; t += 3) {
    const ia = model.indices[t];
    const ib = model.indices[t + 1];
    const ic = model.indices[t + 2];
    const cx = (model.positions[ia * 3] + model.positions[ib * 3] + model.positions[ic * 3]) / 3;
    const cy = (model.positions[ia * 3 + 1] + model.positions[ib * 3 + 1] + model.positions[ic * 3 + 1]) / 3;
    const cz = (model.positions[ia * 3 + 2] + model.positions[ib * 3 + 2] + model.positions[ic * 3 + 2]) / 3;
    const d = Math.hypot(cx - point[0], cy - point[1], cz - point[2]);
    if (d < bestDistance) {
      bestDistance = d;
      best = t / 3;
    }
  }
  return best >= 0 ? best : null;
}
