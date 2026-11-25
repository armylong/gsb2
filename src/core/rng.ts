/**
 * 固定种子的伪随机数发生器。游戏里做可复现的"卡顿现场"很重要：
 * 同一个种子必须每次生成完全相同的贴图、精灵分布与批次切分。
 */
export type Rng = () => number;

/** mulberry32：32 位状态、速度快、跨浏览器结果一致。 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 与 x/y 绑定的确定性哈希，用于逐像素噪点，不依赖调用顺序。 */
export function hash2d(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function range(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length) % items.length];
  if (item === undefined) throw new Error('pick() received an empty list');
  return item;
}

/** FNV-1a，用于给缓冲区/场景做一个可展示的短指纹。 */
export function fnv1a(bytes: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]! & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function toHex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
