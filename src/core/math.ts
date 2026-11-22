import type { Vec3 } from './types';

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Vec3): number {
  return Math.sqrt(lengthSq(a));
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt(distanceSq(a, b));
}

export function distanceSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/** 空间哈希（用于容差内的近邻查询）。cell 必须为正。 */
export class PointHash {
  private readonly cell: number;
  private readonly buckets = new Map<string, number[]>();
  private readonly points: Vec3[];

  constructor(points: Vec3[], cell: number) {
    this.points = points;
    this.cell = Math.max(cell, 1e-9);
    for (let i = 0; i < points.length; i++) {
      const key = this.keyOf(points[i]);
      const arr = this.buckets.get(key);
      if (arr) arr.push(i);
      else this.buckets.set(key, [i]);
    }
  }

  private keyOf(p: Vec3): string {
    return `${Math.floor(p.x / this.cell)},${Math.floor(p.y / this.cell)},${Math.floor(p.z / this.cell)}`;
  }

  /** 返回 27 个相邻 cell 内的点索引（可能包含重复？不会，每个点只在一个 bucket）。 */
  query(p: Vec3): number[] {
    const cx = Math.floor(p.x / this.cell);
    const cy = Math.floor(p.y / this.cell);
    const cz = Math.floor(p.z / this.cell);
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const arr = this.buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (arr) out.push(...arr);
        }
      }
    }
    return out;
  }

  /** 查询范围内所有点（在三个轴向的 cell 范围都覆盖到）。 */
  queryRange(p: Vec3, radius: number): number[] {
    const cell = this.cell;
    const reach = Math.ceil(radius / cell) + 1;
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    const cz = Math.floor(p.z / cell);
    const out: number[] = [];
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dz = -reach; dz <= reach; dz++) {
          const arr = this.buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (arr) out.push(...arr);
        }
      }
    }
    return out;
  }

  get size(): number {
    return this.points.length;
  }
}
