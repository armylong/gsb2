// 确定性随机：mulberry32 + 字符串哈希。
// 同一种子下所有抖动（压深、格内积雪速率）完全可复现，
// 因此「同一时刻重开」能精确复现脚印状态。

export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 基于字符串种子创建确定性随机数生成器，返回 [0,1) 的浮点序列 */
export function mulberry32(seed: string): () => number {
  let a = hashString(seed);
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从父级 rng 派生子序列（不影响父序列），用于按格/按步的独立抖动 */
export function deriveRng(parentSeed: string, tag: string): () => number {
  return mulberry32(`${parentSeed}::${tag}`);
}
