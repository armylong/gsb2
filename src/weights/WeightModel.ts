/**
 * 蒙皮权重数据模型(纯逻辑,不依赖 three.js / DOM,可直接在 Node 下单测)。
 *
 * 每个顶点对 3 根骨骼各有一个权重,所有权重恒满足:
 *   1. 0 <= w <= 1
 *   2. w0 + w1 + w2 = 1(归一约束)
 *
 * 骨骼可被"锁定":锁定骨骼的权重在笔刷修改与归一化过程中保持不变,
 * 增量只在未锁定骨骼之间按比例再分配。
 */

export const BONE_COUNT = 3;

export interface PaintOptions {
  /** 目标骨骼索引 [0, BONE_COUNT) */
  bone: number;
  /** 增量。add 模式为正、subtract 模式为负;调用方负责传号 */
  delta: number;
  /** 锁定标记,true 的骨骼权重保持不变 */
  locked: boolean[];
}

export const SUM_EPSILON = 1e-6;

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export class WeightModel {
  /** 长度 vertexCount * BONE_COUNT 的扁平数组,布局 [v0w0, v0w1, v0w2, v1w0, ...] */
  readonly data: Float32Array;
  readonly vertexCount: number;

  constructor(vertexCount: number, data?: Float32Array) {
    this.vertexCount = vertexCount;
    if (data) {
      if (data.length !== vertexCount * BONE_COUNT) {
        throw new Error(`权重数据长度应为 ${vertexCount * BONE_COUNT},实际为 ${data.length}`);
      }
      this.data = new Float32Array(data);
    } else {
      this.data = new Float32Array(vertexCount * BONE_COUNT);
    }
  }

  get(v: number, b: number): number {
    return this.data[v * BONE_COUNT + b];
  }

  setRaw(v: number, b: number, w: number): void {
    this.data[v * BONE_COUNT + b] = clamp01(w);
  }

  /** 读取某顶点的全部权重(拷贝) */
  weightsOf(v: number): number[] {
    const out: number[] = [];
    for (let b = 0; b < BONE_COUNT; b++) out.push(this.get(v, b));
    return out;
  }

  sumAt(v: number): number {
    let s = 0;
    for (let b = 0; b < BONE_COUNT; b++) s += this.get(v, b);
    return s;
  }

  /**
   * 笔刷修改单个顶点:
   * - 目标骨骼为锁定骨骼时直接忽略(锁定权重不可改);
   * - 先给目标骨骼加 delta(夹到 [0,1]);
   * - 差值按比例分摊到其余"未锁定"骨骼,锁定骨骼不动;
   * - 所有未锁定骨骼都为 0(无法吸收差值)时忽略本次修改,保证归一不被破坏。
   */
  paintVertex(v: number, opts: PaintOptions): boolean {
    const { bone, delta, locked } = opts;
    if (bone < 0 || bone >= BONE_COUNT) throw new Error(`非法骨骼索引: ${bone}`);
    if (locked[bone]) return false;

    const w = this.weightsOf(v);
    const target = clamp01(w[bone] + delta);
    const actualDelta = target - w[bone];
    if (Math.abs(actualDelta) < 1e-9) return false;

    const next = [...w];
    next[bone] = target;

    // 需要从其余未锁定骨骼中抽走(actualDelta>0)或补给(actualDelta<0)的量
    const redistributed = this.distributeProportional(next, w, bone, actualDelta, locked);
    if (!redistributed) return false;

    for (let b = 0; b < BONE_COUNT; b++) this.setRaw(v, b, next[b]);
    return true;
  }

  /**
   * 把 actualDelta 的反向量按比例分摊到除 target 外的未锁定骨骼。
   * actualDelta > 0:从其他骨骼按现有权重比例扣除;
   * actualDelta < 0:按剩余可用空间 (1 - w) 比例补给其他骨骼。
   * 返回 false 表示无法在不破坏归一边界的情况下完成分配。
   */
  private distributeProportional(
    next: number[],
    original: number[],
    target: number,
    actualDelta: number,
    locked: boolean[],
  ): boolean {
    const others = [];
    for (let b = 0; b < BONE_COUNT; b++) {
      if (b !== target && !locked[b]) others.push(b);
    }
    if (others.length === 0) return false;

    if (actualDelta > 0) {
      let pool = 0;
      for (const b of others) pool += original[b];
      if (pool <= 1e-12) return false;
      const need = actualDelta;
      for (const b of others) next[b] = original[b] - (need * original[b]) / pool;
    } else {
      let pool = 0;
      for (const b of others) pool += 1 - original[b];
      if (pool <= 1e-12) return false;
      const give = -actualDelta;
      for (const b of others) next[b] = original[b] + (give * (1 - original[b])) / pool;
    }

    for (const b of others) next[b] = clamp01(next[b]);
    return true;
  }

  /**
   * 套用预设权重,但保留锁定骨骼的现有权重;
   * 未锁定骨骼按预设值的比例重新归一(锁定部分 + 非锁定部分 = 1)。
   */
  applyPresetPreservingLocks(preset: ArrayLike<number>, v: number, locked: boolean[]): void {
    const lockedSum = locked.reduce((acc, isLocked, b) => acc + (isLocked ? this.get(v, b) : 0), 0);
    let presetSum = 0;
    for (let b = 0; b < BONE_COUNT; b++) {
      if (!locked[b]) presetSum += preset[b];
    }
    const remain = clamp01(1 - lockedSum);
    for (let b = 0; b < BONE_COUNT; b++) {
      if (locked[b]) continue;
      const w = presetSum > 1e-12 ? (preset[b] / presetSum) * remain : remain / (BONE_COUNT - locked.filter(Boolean).length);
      this.setRaw(v, b, w);
    }
  }

  /** 深拷贝 */
  clone(): WeightModel {
    return new WeightModel(this.vertexCount, new Float32Array(this.data));
  }

  /** 校验全部顶点满足归一与范围约束(测试与存档恢复时使用) */
  validate(tolerance = SUM_EPSILON): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    for (let v = 0; v < this.vertexCount; v++) {
      for (let b = 0; b < BONE_COUNT; b++) {
        const w = this.get(v, b);
        if (w < -tolerance || w > 1 + tolerance) {
          errors.push(`顶点 ${v} 骨骼 ${b} 权重越界: ${w}`);
        }
      }
      const diff = Math.abs(this.sumAt(v) - 1);
      if (diff > tolerance) errors.push(`顶点 ${v} 权重和不为 1,偏差 ${diff}`);
    }
    return { ok: errors.length === 0, errors };
  }
}
