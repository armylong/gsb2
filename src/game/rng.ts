// 确定性伪随机数：mulberry32。同一种子产生同一序列，
// 自动队伍的偏好打分里所有平手都走它，保证给定种子与选择时结果可重复。

/** 字符串种子稳定哈希为 32 位无符号整数 */
export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 每个自动决策都从固定的派生源取随机数，
 * 与渲染顺序、操作顺序无关，只取决于种子 / 轮次 / 队 / 用途。
 */
export function decisionRng(
  seed: number,
  roundIndex: number,
  teamId: string,
  purpose: string,
): () => number {
  return createRng(hashSeed(`${seed}|r${roundIndex}|${teamId}|${purpose}`));
}
