// 确定性随机数：mulberry32。相同种子产生完全相同的序列，保证可复现。
// 只在"随机生成地图"时使用；规则结算本身不使用随机数，地图相同则结果必然相同。

export class Rng {
  private state: number;

  constructor(seed: number) {
    // 转为 uint32
    this.state = seed >>> 0;
  }

  /** 返回 [0, 1) 的伪随机数，并推进内部状态 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max] 闭区间整数 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  get snapshot(): number {
    return this.state >>> 0;
  }
}
