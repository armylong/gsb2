// 确定性伪随机：抖动与丢包全部走可播种的 RNG，保证同种子可复现。
// mulberry32 —— 单文件无依赖，周期 2^32，足够实验用途。

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

  /** [-1, 1) */
  signed(): number {
    return this.next() * 2 - 1;
  }

  /** 以 pct/100 概率返回 true */
  chance(pct: number): boolean {
    return this.next() * 100 < pct;
  }

  /** 确定性整数 hash，用于为某条链路派生独立子种子 */
  static hash32(n: number): number {
    let x = (n ^ 0x9e3779b9) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return (x ^ (x >>> 16)) >>> 0;
  }
}
