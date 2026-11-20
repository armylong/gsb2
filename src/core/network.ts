import { NetConfig, Packet, Payload } from './protocol';
import { Rng } from './rng';

export interface PacketHistoryEntry {
  id: number;
  channel: 'up' | 'down';
  kind: string;
  sentAtMs: number;
  arriveAtMs: number;
  lost: boolean;
  attempt: number;
  label: string; // 简短描述，供 UI 展示
}

/**
 * 模拟双向链路。关键语义：
 * - 数据包在 send() 的瞬间就根据“当时”的链路参数算出 arriveAtMs；
 *   之后修改延迟/抖动/丢包只影响新包，已在途包的到达时间不变、可查。
 * - 丢包在入链时立刻判定（确定性 RNG），丢包永不投递，由上层重传机制补救。
 * - 链路本身不做去重/排序：重复投递与乱序如实呈现，去重逻辑在权威端。
 */
export class SimNetwork {
  private cfg: NetConfig;
  private rngUp: Rng;
  private rngDown: Rng;
  private nextId = 1;
  readonly inFlight: Packet[] = [];
  readonly history: PacketHistoryEntry[] = [];
  private readonly historyMax = 200;

  constructor(cfg: NetConfig, seed: number) {
    this.cfg = structuredClone(cfg);
    this.rngUp = new Rng(Rng.hash32(seed ^ 0x5151));
    this.rngDown = new Rng(Rng.hash32(seed ^ 0xa7a7));
  }

  /** 只影响之后新发出的包 */
  setConfig(cfg: NetConfig): void {
    this.cfg = structuredClone(cfg);
  }

  /** 重置 RNG（随新一轮实验一起重置，保证录像可复现） */
  reseed(seed: number): void {
    this.rngUp = new Rng(Rng.hash32(seed ^ 0x5151));
    this.rngDown = new Rng(Rng.hash32(seed ^ 0xa7a7));
  }

  send(channel: 'up' | 'down', payload: Payload, nowMs: number): Packet {
    const link = channel === 'up' ? this.cfg.up : this.cfg.down;
    const rng = channel === 'up' ? this.rngUp : this.rngDown;
    // 抖动/丢包为 0 时不得抽 RNG：否则 next()*100 < 0 可能因浮点误差误判丢包
    const jitter = link.jitterMs > 0 ? rng.signed() * link.jitterMs : 0;
    const arriveAt = Math.max(nowMs, nowMs + link.delayMs + jitter);
    const lost = link.lossPct > 0 ? rng.chance(link.lossPct) : false;
    const attempt = payload.kind === 'input' ? payload.attempt : 1;
    const pkt: Packet = {
      id: this.nextId++,
      channel,
      payload,
      sentAtMs: nowMs,
      arriveAtMs: arriveAt,
      attempt,
      lost,
    };
    this.inFlight.push(pkt);
    this.pushHistory(pkt);
    return pkt;
  }

  /** 取出当前时刻应到达的包（含被标记丢失的包——丢失包在到期时静默移除，不投递） */
  poll(nowMs: number): Packet[] {
    const due: Packet[] = [];
    const remain: Packet[] = [];
    for (const pkt of this.inFlight) {
      if (pkt.arriveAtMs <= nowMs) {
        if (!pkt.lost) due.push(pkt);
      } else {
        remain.push(pkt);
      }
    }
    this.inFlight.length = 0;
    this.inFlight.push(...remain);
    return due;
  }

  /** 清空在途与历史（重置轮次时调用，旧消息物理上不再可能到达） */
  clear(): void {
    this.inFlight.length = 0;
    this.history.length = 0;
  }

  countInFlight(channel?: 'up' | 'down'): number {
    return channel ? this.inFlight.filter((p) => p.channel === channel).length : this.inFlight.length;
  }

  private pushHistory(pkt: Packet): void {
    const p = pkt.payload;
    const label =
      p.kind === 'input'
        ? `输入 #${p.input.seq}${pkt.attempt > 1 ? ` 重传x${pkt.attempt}` : ''}`
        : `快照 srvTick=${p.serverTick} ack<=${p.lastProcessedSeq}`;
    this.history.unshift({
      id: pkt.id,
      channel: pkt.channel,
      kind: p.kind,
      sentAtMs: pkt.sentAtMs,
      arriveAtMs: pkt.arriveAtMs,
      lost: pkt.lost,
      attempt: pkt.attempt,
      label,
    });
    if (this.history.length > this.historyMax) this.history.length = this.historyMax;
  }
}
