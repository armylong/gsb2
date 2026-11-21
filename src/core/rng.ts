/** 可复现的伪随机数发生器（mulberry32）。 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) */
  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** [min, max] 整数 */
  int(min: number, max: number): number {
    return Math.floor(this.between(min, max + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** 近似正态分布，用于让尺寸分布更集中等 */
  gaussian(mean: number, stdDev: number): number {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
