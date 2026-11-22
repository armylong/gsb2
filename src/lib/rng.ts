/**
 * 确定性伪随机数 (mulberry32) 与采样辅助函数。
 * 同一种子产生完全一致的点云, 保证场景可复现。
 */
export class RNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) 均匀分布 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) 均匀分布 */
  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** [0, max) 整数 */
  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  /** Box-Muller 高斯采样 */
  gaussian(mean = 0, std = 1): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 单位球面均匀方向 */
  unitVector(): [number, number, number] {
    const z = this.uniform(-1, 1);
    const theta = this.uniform(0, 2 * Math.PI);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return [r * Math.cos(theta), z, r * Math.sin(theta)];
  }
}

/** 字符串种子 -> 32 位整数 */
export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
