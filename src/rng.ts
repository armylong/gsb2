/** 确定性随机工具：所有随机性都由字符串种子派生，保证同种子复现。 */

export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 与遍历顺序无关的逐格随机数：同一 (seed, x, y, salt) 永远得到同一值。 */
export function hash2(seed: number, x: number, y: number, salt = 0): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ Math.imul(x, 0x85ebca6b), 0xc2b2ae35);
  h = Math.imul(h ^ Math.imul(y, 0x27d4eb2f), 0x165667b1);
  h = Math.imul(h ^ salt, 0x9e3779b9);
  h ^= h >>> 13;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
