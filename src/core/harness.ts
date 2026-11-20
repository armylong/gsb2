import { PredictedClient } from './client';
import { SimNetwork } from './network';
import {
  HarnessEvent,
  Input,
  NetConfig,
  Packet,
  SnapshotPayload,
  TICK_MS,
  TRAIL_MAX,
  Vec2,
} from './protocol';
import { Rng } from './rng';
import { NetEvent, ScenarioDef } from './scenarios';
import { AuthorityServer } from './server';
import { createWorld, distance } from './world';

export interface HarnessSettings {
  seed: number;
  net: NetConfig;
  smoothing: boolean;
  tauMs: number;
  showTrail: boolean;
  pushZone: boolean;
}

export interface LiveStats {
  timeMs: number;
  tick: number;
  logicalError: number;
  visualError: number;
  maxLogicalError: number;
  ackedSeq: number;
  unackedCount: number;
  inFlightUp: number;
  inFlightDown: number;
  serverBuffered: number;
  serverApplied: number;
  serverTick: number;
  converged: boolean;
  quiet: boolean;
  traceFinished: boolean;
}

const CONVERGE_EPS = 1e-6;

/**
 * 实验台总控。使用固定步长虚拟时钟：每次 tick 推进恰好 1/60 秒，
 * 单步 = 一个 tick；暂停即不推进。所有消息都在这条时间轴上排队到期。
 */
export class Harness {
  readonly world = createWorld();
  net: SimNetwork;
  client: PredictedClient;
  server: AuthorityServer;
  epoch = 1;
  tick = 0;
  nowMs = 0;
  private lastFrameMs = -1;
  settings: HarnessSettings;
  scenario: ScenarioDef | null = null;
  private eventIndex = 0;
  manualKeys = 0;
  trailPredicted: Vec2[] = [];
  trailServer: Vec2[] = [];
  events: HarnessEvent[] = [];
  lastError = { logical: 0, visual: 0 };

  constructor(settings: HarnessSettings) {
    this.settings = structuredClone(settings);
    this.net = new SimNetwork(this.settings.net, this.settings.seed);
    this.client = new PredictedClient(this.world, this.epoch);
    this.server = new AuthorityServer(this.world, this.epoch);
    this.server.pushZoneEnabled = this.settings.pushZone;
  }

  loadScenario(scenario: ScenarioDef | null): void {
    this.scenario = scenario;
    this.reset();
    if (scenario) this.log('info', `已载入场景「${scenario.name}」并重置（epoch=${this.epoch}）`);
  }

  /** 清空重来：epoch 递增，网络清空，旧轮次消息即使残留也会被两端按 epoch 拒绝 */
  reset(): void {
    this.epoch += 1;
    this.tick = 0;
    this.nowMs = 0;
    this.lastFrameMs = -1;
    this.eventIndex = 0;
    this.net = new SimNetwork(this.settings.net, this.settings.seed);
    this.client.reset(this.epoch);
    this.server.reset(this.epoch);
    this.server.pushZoneEnabled = this.settings.pushZone;
    this.trailPredicted = [];
    this.trailServer = [];
    this.lastError = { logical: 0, visual: 0 };
    this.manualKeys = 0;
    this.log('info', `新一轮开始（epoch=${this.epoch}），链路与所有队列已清空`);
  }

  updateNetConfig(net: NetConfig): void {
    this.settings.net = structuredClone(net);
    this.net.setConfig(net);
  }

  updateSeed(seed: number): void {
    this.settings.seed = seed;
    // 种子在下一轮重置时生效；在途包的到达时间已固定，不追溯
  }

  updateDisplay(smoothing: boolean, tauMs: number, showTrail: boolean): void {
    this.settings.smoothing = smoothing;
    this.settings.tauMs = tauMs;
    this.settings.showTrail = showTrail;
  }

  setPushZone(enabled: boolean): void {
    this.settings.pushZone = enabled;
    this.server.pushZoneEnabled = enabled;
  }

  log(level: HarnessEvent['level'], text: string): void {
    this.events.unshift({ timeMs: Math.round(this.nowMs), level, text });
    if (this.events.length > 120) this.events.length = 120;
  }

  /** 推进一个固定逻辑 tick（运行模式每帧调用一次；单步按钮也调用它） */
  advanceTick(): void {
    // 时间真相 = tick 数 × 固定步长，避免浮点反复累加产生漂移
    this.nowMs = (this.tick + 1) * TICK_MS;
    const now = this.nowMs;

    // 1) 场景网络事件（改参数只影响新消息）
    this.applyScenarioEvents(now);

    // 2) 未确认输入的 RTO 重传
    this.client.checkRetransmit(now, (input, attempt) => this.sendInput(input, attempt));

    // 3) 产生本 tick 输入：有真实按键才序号化发送，预测端同 tick 立即移动
    const keys = this.currentKeys();
    this.client.step(this.tick, keys, now, (input, attempt) => this.sendInput(input, attempt));
    this.tick++;

    // 4) 投递到期包（输入进权威端；快照进预测端）
    this.deliver(now);

    // 5) 权威端按序应用输入并按需发快照
    this.server.advance((snap) => {
      this.net.send('down', snap, now);
    });

    // 6) 零延迟时本轮快照可能立刻到期，再投递一次
    this.deliver(now);

    // 7) 视觉平滑（只影响渲染点）
    this.client.updateRender(now, this.lastFrameMs < 0 ? now : this.lastFrameMs, this.settings.smoothing, this.settings.tauMs);
    this.lastFrameMs = now;

    // 8) 误差与轨迹
    this.lastError = this.client.recordError(this.server.pos);
    if (this.settings.showTrail && this.tick % 2 === 0) {
      this.trailPredicted.push({ ...this.client.pos });
      this.trailServer.push({ ...this.server.pos });
      if (this.trailPredicted.length > TRAIL_MAX) {
        this.trailPredicted.shift();
        this.trailServer.shift();
      }
    }
  }

  private sendInput(input: Input, attempt: number): void {
    this.net.send('up', { kind: 'input', input, attempt }, this.nowMs);
  }

  private deliver(now: number): void {
    const due: Packet[] = this.net.poll(now);
    for (const pkt of due) {
      if (pkt.payload.kind === 'input') {
        const input = pkt.payload.input;
        const result = this.server.receive(input);
        if (result === 'duplicate') {
          this.log('warn', `重复输入 #${input.seq}（第${pkt.attempt}次送达）被权威端拒绝，不重复移动`);
        } else if (result === 'stale-epoch') {
          this.log('warn', `旧轮次(epoch=${input.epoch})输入 #${input.seq} 被隔离丢弃`);
        }
      } else {
        const snap = pkt.payload as SnapshotPayload;
        const result = this.client.handleSnapshot(snap, now);
        if (result === 'stale-tick') {
          this.log('warn', `乱序旧快照 srvTick=${snap.serverTick} 晚到被拒绝（当前已到 ${this.client.lastAppliedServerTick}）`);
        } else if (result === 'stale-epoch') {
          this.log('warn', `旧轮次(epoch=${snap.epoch})快照被隔离丢弃`);
        } else if (result === 'accepted') {
          const c = this.client.lastCorrection;
          if (c && c.atMs === now) {
            this.log('warn', `逻辑纠正：快照 srvTick=${snap.serverTick} 确认<=${snap.lastProcessedSeq}，位置修正 ${c.delta.toFixed(2)}px`);
          }
        }
      }
    }
  }

  private applyScenarioEvents(now: number): void {
    if (!this.scenario) return;
    const evs: NetEvent[] = this.scenario.events;
    while (this.eventIndex < evs.length && evs[this.eventIndex].atMs <= now) {
      const ev = evs[this.eventIndex++];
      if (ev.type === 'setLink') {
        const link = { ...this.settings.net[ev.channel], ...ev.patch };
        const next: NetConfig = { ...this.settings.net, [ev.channel]: link };
        this.updateNetConfig(next);
      } else {
        this.log('info', ev.text);
      }
    }
  }

  private currentKeys(): number {
    if (this.scenario) {
      const trace = this.scenario.keysPerTick;
      return trace[this.tick] ?? 0;
    }
    return this.manualKeys;
  }

  get traceFinished(): boolean {
    if (!this.scenario) return false;
    return this.tick >= this.scenario.keysPerTick.length;
  }

  /**
   * 输入通道收齐：没有待确认输入、上行没有在途包、权威端没有等待补缺的乱序缓存。
   * 下行快照是周期心跳，即使在飞也不影响输入收齐，故不计入。
   */
  isQuiet(): boolean {
    return (
      this.client.unacked.length === 0 &&
      this.net.countInFlight('up') === 0 &&
      this.server.bufferedCount() === 0
    );
  }

  isConverged(): boolean {
    return this.isQuiet() && distance(this.client.pos, this.server.pos) <= CONVERGE_EPS;
  }

  stats(): LiveStats {
    return {
      timeMs: this.nowMs,
      tick: this.tick,
      logicalError: this.lastError.logical,
      visualError: this.lastError.visual,
      maxLogicalError: this.client.counters.maxLogicalError,
      ackedSeq: this.client.ackedSeq,
      unackedCount: this.client.unacked.length,
      inFlightUp: this.net.countInFlight('up'),
      inFlightDown: this.net.countInFlight('down'),
      serverBuffered: this.server.bufferedCount(),
      serverApplied: this.server.appliedInputs,
      serverTick: this.server.tick,
      converged: this.isConverged(),
      quiet: this.isQuiet(),
      traceFinished: this.traceFinished,
    };
  }
}

export { Rng, CONVERGE_EPS };
