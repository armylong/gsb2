/** 固定种子随机数 (mulberry32): 给定种子, 序列完全可重复. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** 由主种子派生一个子种子, 用于某轮/某队的独立随机流. */
export function deriveSeed(seed: number, ...parts: Array<string | number>): number {
  return hashString(`${seed >>> 0}:${parts.join(':')}`);
}
