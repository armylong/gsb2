/**
 * 分块网格任务系统(纯 TS,不依赖 three.js / Worker,可在 Node 中直接测试)。
 *
 * 职责:
 * - 为每个块维护"当前已展示层级"与"期望层级";
 * - 去重:同一块同一层级的在途请求不会重复发出;
 * - 过期控制:每条请求带 requestId 与 terrainEpoch;
 *   被更新请求取代、或属于旧地形代数的结果,回来时一律丢弃,绝不覆盖当前状态;
 * - 统计:在途/累计请求/已应用/过期丢弃/被取代,并判断任务是否收敛。
 */
import { chunkKey } from './config';

export interface RequestDescriptor {
  requestId: number;
  terrainEpoch: number;
  cx: number;
  cz: number;
  lod: number;
  seed: number;
  delayMs: number;
}

interface LedgerEntry {
  requestId: number;
  terrainEpoch: number;
  cx: number;
  cz: number;
  lod: number;
  superseded: boolean;
}

export interface ChunkRuntimeState {
  cx: number;
  cz: number;
  /** 当前已应用网格的层级,null = 尚无网格 */
  currentLod: number | null;
  currentEpoch: number;
  /** 期望层级(最新相机决策) */
  desiredLod: number | null;
  inFlightRequestId: number | null;
  inFlightLod: number | null;
}

export interface TaskStats {
  /** 当前在途任务数(含尚未执行完的慢任务) */
  pending: number;
  /** 累计发出的请求数 */
  totalRequested: number;
  /** 成功应用到块上的结果数 */
  totalApplied: number;
  /** 迟到/旧代数结果被丢弃的次数 */
  totalStale: number;
  /** 在完成前就被新请求取代的次数 */
  totalSuperseded: number;
  terrainEpoch: number;
}

export interface AppliedResult<T = unknown> {
  cx: number;
  cz: number;
  lod: number;
  terrainEpoch: number;
  payload: T;
}

export class TerrainTaskSystem {
  private epoch = 0;
  private seed: number;
  private nextRequestId = 1;
  private readonly ledger = new Map<number, LedgerEntry>();
  private readonly chunks = new Map<string, ChunkRuntimeState>();
  private delayMs = 0;

  readonly stats: TaskStats = {
    pending: 0,
    totalRequested: 0,
    totalApplied: 0,
    totalStale: 0,
    totalSuperseded: 0,
    terrainEpoch: 0,
  };

  constructor(seed: number, chunkCountX: number, chunkCountZ: number) {
    this.seed = seed;
    for (let cx = 0; cx < chunkCountX; cx++) {
      for (let cz = 0; cz < chunkCountZ; cz++) {
        this.chunks.set(chunkKey(cx, cz), {
          cx,
          cz,
          currentLod: null,
          currentEpoch: -1,
          desiredLod: null,
          inFlightRequestId: null,
          inFlightLod: null,
        });
      }
    }
  }

  get terrainEpoch(): number {
    return this.epoch;
  }

  get currentSeed(): number {
    return this.seed;
  }

  setDelay(ms: number): void {
    this.delayMs = Math.max(0, ms);
  }

  getDelay(): number {
    return this.delayMs;
  }

  getChunk(cx: number, cz: number): ChunkRuntimeState {
    const s = this.chunks.get(chunkKey(cx, cz));
    if (!s) throw new Error(`unknown chunk ${cx},${cz}`);
    return s;
  }

  chunkStates(): ChunkRuntimeState[] {
    return [...this.chunks.values()];
  }

  /**
   * 换种子/重建:地形代数 +1,所有块状态复位。
   * 旧代数的在途任务仍保留在台账中,回来时按代数判定为过期并计数。
   */
  rebuild(newSeed: number): void {
    this.seed = newSeed;
    this.epoch += 1;
    this.stats.terrainEpoch = this.epoch;
    for (const s of this.chunks.values()) {
      s.currentLod = null;
      s.currentEpoch = -1;
      s.desiredLod = null;
      // 在途请求标记为被取代(代数已失效)
      if (s.inFlightRequestId !== null) {
        const entry = this.ledger.get(s.inFlightRequestId);
        if (entry && !entry.superseded) {
          entry.superseded = true;
          this.stats.totalSuperseded += 1;
        }
        s.inFlightRequestId = null;
        s.inFlightLod = null;
      }
    }
  }

  /**
   * 表达某块的期望层级,返回需要实际发出的请求描述符;
   * 已满足或有相同在途请求时返回 null(去重)。
   */
  requestChunk(cx: number, cz: number, desiredLod: number): RequestDescriptor | null {
    const s = this.getChunk(cx, cz);
    s.desiredLod = desiredLod;

    // 已展示该层级且属于当前代数,无需重建
    if (s.currentLod === desiredLod && s.currentEpoch === this.epoch) {
      return null;
    }
    // 已有相同层级、相同代数的在途请求
    if (s.inFlightRequestId !== null && s.inFlightLod === desiredLod) {
      const entry = this.ledger.get(s.inFlightRequestId);
      if (entry && entry.terrainEpoch === this.epoch) return null;
    }

    // 旧的在途请求被取代
    if (s.inFlightRequestId !== null) {
      const old = this.ledger.get(s.inFlightRequestId);
      if (old && !old.superseded) {
        old.superseded = true;
        this.stats.totalSuperseded += 1;
      }
    }

    const requestId = this.nextRequestId++;
    this.ledger.set(requestId, {
      requestId,
      terrainEpoch: this.epoch,
      cx,
      cz,
      lod: desiredLod,
      superseded: false,
    });
    s.inFlightRequestId = requestId;
    s.inFlightLod = desiredLod;
    this.stats.pending += 1;
    this.stats.totalRequested += 1;

    return {
      requestId,
      terrainEpoch: this.epoch,
      cx,
      cz,
      lod: desiredLod,
      seed: this.seed,
      delayMs: this.delayMs,
    };
  }

  /**
   * 处理一个异步结果(允许以任意顺序到达)。
   * 返回 AppliedResult 表示应上屏;返回 null 表示过期丢弃。
   */
  handleResult<T>(resp: {
    requestId: number;
    terrainEpoch: number;
    cx: number;
    cz: number;
    lod: number;
    payload: T;
  }): AppliedResult<T> | null {
    const entry = this.ledger.get(resp.requestId);
    const s = this.chunks.get(chunkKey(resp.cx, resp.cz));

    // 台账中不存在:从未登记或已被结算过,一律视为过期
    if (!entry || !s) {
      this.stats.totalStale += 1;
      return null;
    }
    this.ledger.delete(resp.requestId);
    this.stats.pending = Math.max(0, this.stats.pending - 1);

    const stale =
      entry.superseded ||
      resp.terrainEpoch !== this.epoch ||
      entry.terrainEpoch !== this.epoch ||
      s.inFlightRequestId !== resp.requestId;

    if (stale) {
      this.stats.totalStale += 1;
      // 若块上仍指向这条请求,清空在途标记
      if (s.inFlightRequestId === resp.requestId) {
        s.inFlightRequestId = null;
        s.inFlightLod = null;
      }
      return null;
    }

    s.inFlightRequestId = null;
    s.inFlightLod = null;
    s.currentLod = resp.lod;
    s.currentEpoch = resp.terrainEpoch;
    this.stats.totalApplied += 1;
    return {
      cx: resp.cx,
      cz: resp.cz,
      lod: resp.lod,
      terrainEpoch: resp.terrainEpoch,
      payload: resp.payload,
    };
  }

  /**
   * 取消一条仍在本地队列、尚未发给 Worker 的请求。
   * 取代计数已在 requestChunk 时完成,这里只做台账清理与 pending 回退,
   * 保证任务统计最终收敛、无用任务不持续累积。
   */
  cancelQueued(requestId: number): boolean {
    const entry = this.ledger.get(requestId);
    if (!entry) return false;
    this.ledger.delete(requestId);
    this.stats.pending = Math.max(0, this.stats.pending - 1);
    const s = this.chunks.get(chunkKey(entry.cx, entry.cz));
    if (s && s.inFlightRequestId === requestId) {
      s.inFlightRequestId = null;
      s.inFlightLod = null;
    }
    return true;
  }

  /** 该请求当前是否仍有效(未被取代且属于最新地形代数) */
  isRequestLive(requestId: number): boolean {
    const entry = this.ledger.get(requestId);
    if (!entry || entry.superseded || entry.terrainEpoch !== this.epoch) return false;
    const s = this.chunks.get(chunkKey(entry.cx, entry.cz));
    return !!s && s.inFlightRequestId === requestId;
  }

  /** 所有块的当前网格都等于期望层级且无在途任务,即收敛 */
  isConverged(): boolean {
    if (this.stats.pending !== 0) return false;
    for (const s of this.chunks.values()) {
      if (s.currentEpoch !== this.epoch) return false;
      if (s.currentLod !== s.desiredLod || s.desiredLod === null) return false;
    }
    return true;
  }

  /** 仍未满足期望的块(需要补发请求,例如 Worker 池重启场景) */
  unsatisfiedChunks(): ChunkRuntimeState[] {
    return this.chunkStates().filter(
      (s) =>
        s.inFlightRequestId === null &&
        (s.currentEpoch !== this.epoch || s.currentLod !== s.desiredLod),
    );
  }
}
