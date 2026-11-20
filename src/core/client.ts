import { Input, SnapshotPayload, TICK_MS, Vec2, WorldDef } from './protocol';
import { RTO_BASE_MS } from './protocol';
import { distance, moveStep } from './world';

export interface UnackedEntry {
  input: Input;
  attempt: number;
  nextRetryAtMs: number;
}

export interface ClientCounters {
  sent: number; // 首发输入数
  retransmits: number; // 重传次数
  corrections: number; // 逻辑纠正次数
  rejectedSnapshots: number; // 被拒绝的旧/乱序快照
  acceptedSnapshots: number;
  maxLogicalError: number;
}

/**
 * 客户端预测端：
 * - 输入产生的同一 tick 立即本地移动（预测），同时可靠发往权威端；
 * - 未确认输入按 RTO 重传，保证“有限丢包结束后动作最终送达”；
 * - 收到快照只接受 serverTick 严格更新的，重放未确认输入做校正；
 * - 逻辑位置与渲染位置分离，平滑只影响渲染。
 */
export class PredictedClient {
  epoch: number;
  tick = 0;
  private nextSeq = 1;
  pos: Vec2; // 逻辑位置（碰撞与后续预测的依据）
  renderPos: Vec2; // 视觉位置（平滑回正只动这里）
  unacked: UnackedEntry[] = [];
  ackedSeq = 0;
  lastAppliedServerTick = -1;
  counters: ClientCounters = {
    sent: 0,
    retransmits: 0,
    corrections: 0,
    rejectedSnapshots: 0,
    acceptedSnapshots: 0,
    maxLogicalError: 0,
  };
  lastCorrection: { from: Vec2; to: Vec2; delta: number; atMs: number } | null = null;

  constructor(
    private world: WorldDef,
    epoch: number,
  ) {
    this.epoch = epoch;
    this.pos = { ...world.spawn };
    this.renderPos = { ...world.spawn };
  }

  reset(epoch: number): void {
    this.epoch = epoch;
    this.tick = 0;
    this.nextSeq = 1;
    this.pos = { ...this.world.spawn };
    this.renderPos = { ...this.world.spawn };
    this.unacked = [];
    this.ackedSeq = 0;
    this.lastAppliedServerTick = -1;
    this.counters = { sent: 0, retransmits: 0, corrections: 0, rejectedSnapshots: 0, acceptedSnapshots: 0, maxLogicalError: 0 };
    this.lastCorrection = null;
  }

  /**
   * 推进客户端一个 tick。
   * 只有存在真实方向按键时才产生带序号的输入并首发到链路；
   * keys=0 的 tick 不产生消息（零输入移动结果与原地不动等价，无需序号化），
   * 这样“停止输入”后队列才能真正排空、两端才能收敛。
   */
  step(tick: number, keys: number, nowMs: number, send: (input: Input, attempt: number) => void): Input | null {
    if (keys === 0) {
      this.tick = tick + 1;
      return null;
    }
    const input: Input = { seq: this.nextSeq++, tick, keys, epoch: this.epoch };
    // 1) 立即影响本地角色
    this.pos = moveStep(this.world, this.pos, keys);
    // 2) 登记为未确认并首发
    this.unacked.push({ input, attempt: 1, nextRetryAtMs: nowMs + RTO_BASE_MS });
    this.counters.sent++;
    send(input, 1);
    this.tick = tick + 1;
    return input;
  }

  /**
   * RTO 重传检查：只对仍未确认的输入重发，重传包按当前链路参数重新计算到达时间。
   * 每次触发后把下次重传时刻从“当前时刻”向后排一个退避间隔：
   * - 正常情况下每个 RTO 间隔最多重发一次，不会刷爆链路；
   * - 即使某 tick 扫描被跳过，下个 tick 立即补发，之后节奏恢复，不形成活锁。
   */
  checkRetransmit(nowMs: number, send: (input: Input, attempt: number) => void): void {
    for (const entry of this.unacked) {
      if (nowMs >= entry.nextRetryAtMs) {
        entry.attempt += 1;
        const rto = Math.min(1200, RTO_BASE_MS * Math.pow(1.5, entry.attempt - 1));
        entry.nextRetryAtMs = nowMs + rto;
        this.counters.retransmits++;
        send(entry.input, entry.attempt);
      }
    }
  }

  /**
   * 处理权威快照：
   * - 轮次不符 / 旧快照（serverTick 不新）→ 拒绝，确认进度绝不倒退；
   * - 确认快照中 lastProcessedSeq 及以前的输入；
   * - 从权威位置出发，按顺序只重放“尚未确认”的输入，已确认移动绝不重算（不会加速）。
   */
  handleSnapshot(snap: SnapshotPayload, nowMs: number): 'accepted' | 'stale-tick' | 'stale-epoch' {
    if (snap.epoch !== this.epoch) return 'stale-epoch';
    if (snap.serverTick <= this.lastAppliedServerTick) {
      this.counters.rejectedSnapshots++;
      return 'stale-tick';
    }
    this.lastAppliedServerTick = snap.serverTick;
    this.counters.acceptedSnapshots++;

    // 确认并移除已处理输入（顺序表，直接截前缀）
    let cut = 0;
    while (cut < this.unacked.length && this.unacked[cut].input.seq <= snap.lastProcessedSeq) cut++;
    if (cut > 0) {
      this.unacked.splice(0, cut);
      this.ackedSeq = snap.lastProcessedSeq;
    }

    // 校正：权威基准 + 仅重放未确认输入
    const before = { ...this.pos };
    let reconciled: Vec2 = { ...snap.pos };
    for (const entry of this.unacked) {
      reconciled = moveStep(this.world, reconciled, entry.input.keys);
    }
    const delta = distance(before, reconciled);
    if (delta > 1e-6) {
      this.counters.corrections++;
      this.lastCorrection = { from: before, to: { ...reconciled }, delta, atMs: nowMs };
    }
    this.pos = reconciled;
    return 'accepted';
  }

  /** 视觉层平滑：指数趋近逻辑位置；关闭平滑时直接对齐（立刻看见修正） */
  updateRender(nowMs: number, lastFrameMs: number, smoothing: boolean, tauMs: number): void {
    if (!smoothing || tauMs <= 0) {
      this.renderPos = { ...this.pos };
      return;
    }
    const dt = Math.max(0, nowMs - lastFrameMs);
    const alpha = 1 - Math.exp(-dt / tauMs);
    this.renderPos.x += (this.pos.x - this.renderPos.x) * alpha;
    this.renderPos.y += (this.pos.y - this.renderPos.y) * alpha;
  }

  recordError(serverPos: Vec2): { logical: number; visual: number } {
    const logical = distance(this.pos, serverPos);
    if (logical > this.counters.maxLogicalError) this.counters.maxLogicalError = logical;
    return { logical, visual: distance(this.renderPos, serverPos) };
  }

  get tickMs(): number {
    return TICK_MS;
  }
}
