/**
 * 确定性随机数:mulberry32 + 字符串种子哈希。
 * 相同种子在任何 JS 运行时上产生相同序列。
 */

export function hashSeed(seed: string): number {
  // FNV-1a 32bit,字符串逐字符处理,结果与平台无关
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: string | number) {
    this.state = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
    // 避免全零状态(虽然 mulberry32 仍可工作,但先做一次扰动)
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** [0, 1) 的 32 位浮点 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max] 的整数,两端闭区间 */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`Rng.int: max(${max}) < min(${min})`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** 从数组中取一个元素(不修改原数组) */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick: empty array');
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Fisher–Yates 洗牌,返回新数组 */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  get snapshot(): number {
    return this.state >>> 0;
  }
}
