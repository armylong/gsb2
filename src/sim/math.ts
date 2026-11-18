/**
 * 二维向量工具与确定性随机数。
 * 所有模拟随机量都来自 mulberry32(seed),保证同种子完全可复现。
 */

export interface Vec {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
/** 二维叉积 z 分量:正值表示 b 在 a 的逆时针方向 */
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const lenSq = (a: Vec): number => a.x * a.x + a.y * a.y;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);

export const norm = (a: Vec): Vec => {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

export const EPS = 1e-9;

/** 确定性 PRNG,只用于布局噪声等可复现场景 */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
}
