/**
 * 可复现的随机数发生器。
 *
 * 设计要求 (对应第 7 条): 每次抽卡都要能记录"抽卡前的随机状态", 并且从任意
 * 快照恢复后继续跑, 结果必须与一次跑完全量逐条一致。所以这里用纯函数的
 * 32 位 PRNG (mulberry32), 状态就是一个 uint32, 可序列化、可比较。
 */

export interface RngState {
  /** 当前状态字, 0 <= state < 2^32 */
  readonly state: number;
  /** 已经产出的随机数个数, 便于调试 */
  readonly draws: number;
}

export interface Rng {
  readonly state: RngState;
  /** [0, 1) 均匀分布 */
  next(): number;
  snapshot(): RngState;
}

const UINT32 = 0x1_0000_0000;

/** 把任意字符串 (种子) 混成一个 uint32, FNV-1a */
export function hashSeed(seed: string | number): number {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) throw new Error(`种子必须是有限数, 收到 ${String(seed)}`);
    return (Math.trunc(seed) >>> 0) || 0x9e3779b9;
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 从快照恢复 RNG, 并校验快照本身合法 */
export function rngFromState(snapshot: RngState): Rng {
  if (!Number.isInteger(snapshot.state) || snapshot.state < 0 || snapshot.state >= UINT32) {
    throw new Error(`随机状态非法: ${String(snapshot.state)}`);
  }
  if (!Number.isInteger(snapshot.draws) || snapshot.draws < 0) {
    throw new Error(`随机数计数非法: ${String(snapshot.draws)}`);
  }
  let state = snapshot.state >>> 0;
  let draws = snapshot.draws;

  const rng: Rng = {
    get state() {
      return { state, draws };
    },
    next() {
      // mulberry32
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      draws++;
      return ((t ^ (t >>> 14)) >>> 0) / UINT32;
    },
    snapshot() {
      return { state, draws };
    },
  };
  return rng;
}

export function createRng(seed: string | number): Rng {
  return rngFromState({ state: hashSeed(seed), draws: 0 });
}
