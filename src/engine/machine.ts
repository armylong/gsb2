import { evaluateTransitions, normalizeInputs, orderedEvents } from './select';
import type {
  AnimEvent,
  AnimState,
  LogEntry,
  MachineConfig,
  MachineInputs,
  MachineSnapshot,
  TransitionStatus,
} from './types';

const EPS = 1e-9;

export interface MachineOptions {
  /** 覆盖配置里的 initialState, 用于示例与测试; 必须存在于配置中 */
  initialStateId?: string;
  /** 确定初态输入; reset() 会回到这份输入 */
  initialInputs?: MachineInputs;
}

interface OrderedEvent {
  event: AnimEvent;
  index: number;
}

/**
 * 确定性动画状态机。
 *
 * 时间语义:
 * - 每个 update 是一个更新周期, 最多发生一次状态切换;
 * - 更新周期开始时先按当前进度评估过渡, 满足则立即切换, 剩余时间交给新状态;
 * - 若某过渡只差"等待进度", 且在本周期内到达阈值, 会先推进到阈值时刻再切换,
 *   阈值之前已发生的事件照常触发, 之后的事件不再发生;
 * - 事件按时间顺序消费, 一次推进跨过多个事件或多个循环边界也不会遗漏/重复;
 *   同一时刻的事件按事件数组中的原始顺序触发。
 */
export class AnimationMachine {
  private readonly config: MachineConfig;
  private readonly initialStateId: string;
  private readonly initialInputs: Required<MachineInputs>;
  private readonly eventCache = new Map<string, OrderedEvent[]>();

  private inputs: Required<MachineInputs>;
  private state: AnimState;
  private stateElapsedMs = 0;
  private stateTimeMs = 0;
  private loopIndex = 0;
  private eventCursor = 0;
  private finished = false;
  private windowOpen = false;
  private clockMs = 0;
  private tick = 0;
  private seq = 0;
  private lastTransitionId: string | null = null;
  private logEntries: LogEntry[] = [];

  constructor(config: MachineConfig, options: MachineOptions = {}) {
    this.config = config;
    this.initialInputs = normalizeInputs(options.initialInputs ?? {});
    this.inputs = { ...this.initialInputs };
    for (const state of config.states) {
      this.eventCache.set(state.id, orderedEvents(state));
    }
    const initialStateId = options.initialStateId ?? config.initialState;
    const state =
      config.states.find((s) => s.id === initialStateId) ?? config.states[0];
    if (!state) {
      throw new Error('配置必须至少包含一个状态');
    }
    this.initialStateId = state.id;
    this.state = state;
    this.restart(false);
  }

  get configRef(): MachineConfig {
    return this.config;
  }

  get currentStateId(): string {
    return this.state.id;
  }

  get log(): readonly LogEntry[] {
    return this.logEntries;
  }

  get pendingAttacks(): number {
    return this.inputs.pendingAttacks;
  }

  /** 回到配置/示例的确定初态: 时钟清零, 输入回到初态, 日志重新开始。 */
  reset(): void {
    this.restart(true);
  }

  /**
   * 推进一个更新周期。dtMs 为模拟时间(毫秒), 允许 0 或小数。
   * 一次调用最多切换一次状态。
   */
  update(dtMs: number): void {
    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    this.tick += 1;

    const immediate = this.evaluate();
    if (immediate.winner) {
      this.applyTransition(immediate.winner);
      if (dt > EPS) this.advance(dt);
      return;
    }

    const gate = this.earliestProgressGate(immediate.statuses, dt);
    if (gate !== null) {
      this.advance(gate);
      const atGate = this.evaluate();
      if (atGate.winner) {
        this.applyTransition(atGate.winner);
        const remaining = dt - gate;
        if (remaining > EPS) this.advance(remaining);
        return;
      }
      const remaining = dt - gate;
      if (remaining > EPS) this.advance(remaining);
      return;
    }

    if (dt > EPS) this.advance(dt);
  }

  setSpeed(value: number): void {
    if (!Number.isFinite(value)) return;
    const next = Math.max(0, value);
    if (next === this.inputs.speed) return;
    this.inputs.speed = next;
    this.pushInput('speed', `速度 → ${next.toFixed(2)}`);
  }

  setHurt(value: boolean): void {
    if (value === this.inputs.hurt) return;
    this.inputs.hurt = value;
    this.pushInput('hurt', `受击 → ${value ? '是' : '否'}`);
  }

  /** 排入一次待处理攻击; 只有实际采用攻击触发过渡时才消耗。 */
  queueAttack(count = 1): void {
    const amount = Math.max(1, Math.floor(count));
    this.inputs.pendingAttacks += amount;
    this.pushInput(
      'queue-attack',
      `排队 +${amount} (待处理 ${this.inputs.pendingAttacks})`,
    );
  }

  /** 清除未被任何被采用过渡消耗的触发。 */
  clearAttacks(): void {
    if (this.inputs.pendingAttacks === 0) return;
    const before = this.inputs.pendingAttacks;
    this.inputs.pendingAttacks = 0;
    this.pushInput('clear-attacks', `清除 ${before} 个待处理触发`);
  }

  getSnapshot(): MachineSnapshot {
    const evaluation = this.evaluate();
    return {
      configName: this.config.name,
      state: this.state,
      stateId: this.state.id,
      stateName: this.state.name,
      elapsedMs: this.stateElapsedMs,
      stateTimeMs: this.stateTimeMs,
      progress: this.progress(),
      loopIndex: this.loopIndex,
      finished: this.finished,
      attackWindowOpen: this.windowOpen,
      pendingAttacks: this.inputs.pendingAttacks,
      speed: this.inputs.speed,
      hurt: this.inputs.hurt,
      clockMs: this.clockMs,
      tick: this.tick,
      lastTransitionId: this.lastTransitionId,
      transitionStatuses: evaluation.statuses,
      log: this.logEntries,
      logLength: this.logEntries.length,
    };
  }

  // ---------------------------------------------------------------- internals

  private restart(reset: boolean): void {
    this.inputs = { ...this.initialInputs };
    this.clockMs = 0;
    this.tick = 0;
    this.seq = 0;
    this.logEntries = [];
    this.lastTransitionId = null;
    this.windowOpen = false;
    this.loopIndex = 0;
    this.eventCursor = 0;
    this.finished = false;
    this.stateElapsedMs = 0;
    this.stateTimeMs = 0;
    if (reset) {
      this.state =
        this.config.states.find((s) => s.id === this.initialStateId) ??
        this.config.states[0];
    }
    this.logEntries.push({
      type: 'reset',
      seq: ++this.seq,
      atMs: 0,
      tick: 0,
      stateId: this.state.id,
      speed: this.inputs.speed,
      hurt: this.inputs.hurt,
      pendingAttacks: this.inputs.pendingAttacks,
    });
    this.enterState(this.state, true, null);
  }

  private eventsFor(state: AnimState): OrderedEvent[] {
    return this.eventCache.get(state.id) ?? orderedEvents(state);
  }

  private progress(): number {
    const duration = this.state.durationMs;
    if (duration <= 0) return 1;
    return Math.min(1, Math.max(0, this.stateElapsedMs / duration));
  }

  private evaluate() {
    // 循环状态以"当前圈"的局部时间计进度, 不用累计时间。
    return evaluateTransitions(
      this.config,
      this.state.id,
      this.inputs,
      this.stateElapsedMs,
      this.state.durationMs,
      this.finished,
    );
  }

  /**
   * 找出本周期内第一个只差"等待进度"的过渡阈值。
   * 返回需要先推进的毫秒数; 没有则返回 null。
   */
  private earliestProgressGate(
    statuses: TransitionStatus[],
    dt: number,
  ): number | null {
    let earliest: number | null = null;
    for (const status of statuses) {
      if (status.reasons.length !== 1 || status.reasons[0] !== 'wait-progress') {
        continue;
      }
      const thresholdTime = status.transition.progress * this.state.durationMs;
      const delta = thresholdTime - this.stateElapsedMs;
      if (delta < 0 || delta > dt + EPS) continue;
      if (earliest === null || delta < earliest) earliest = delta;
    }
    if (earliest === null) return null;
    return earliest;
  }

  private enterState(
    state: AnimState,
    initial: boolean,
    transitionId: string | null,
  ): void {
    this.state = state;
    this.stateElapsedMs = 0;
    this.stateTimeMs = 0;
    this.loopIndex = 0;
    this.eventCursor = 0;
    this.finished = false;
    this.windowOpen = false;

    this.logEntries.push({
      type: 'state-enter',
      seq: ++this.seq,
      atMs: this.clockMs,
      tick: this.tick,
      stateId: state.id,
      stateName: state.name,
      initial,
      loopIndex: 0,
      transitionId,
    });
    this.fireTimeZeroEvents(this.eventsFor(state));
  }

  /** 进入动作/回到循环起点时, timeMs === 0 的事件立即触发。 */
  private fireTimeZeroEvents(events: OrderedEvent[]): void {
    while (
      this.eventCursor < events.length &&
      events[this.eventCursor].event.timeMs <= EPS
    ) {
      const entry = events[this.eventCursor];
      this.emitEvent(entry.event, this.clockMs);
      this.eventCursor += 1;
    }
  }

  /**
   * 推进当前动作 dt 毫秒, 途中按顺序触发事件; 循环动作会处理任意多个循环边界。
   */
  private advance(dt: number): void {
    if (dt <= EPS) return;
    const state = this.state;
    if (state.durationMs <= EPS) {
      // 非法配置的兜底: 不进入无限循环, 只推进时钟。
      this.clockMs += dt;
      this.finished = true;
      return;
    }
    const events = this.eventsFor(state);

    if (state.loop) {
      let remaining = dt;
      let guard = 0;
      while (remaining > EPS) {
        guard += 1;
        if (guard > 1_000_000) {
          throw new Error('循环推进次数异常, 请检查状态时长');
        }
        const toBoundary = state.durationMs - this.stateElapsedMs;
        const step = Math.min(remaining, toBoundary);
        this.advanceSegment(step, events);
        remaining -= step;

        if (this.stateElapsedMs >= state.durationMs - EPS) {
          this.stateElapsedMs = 0;
          this.loopIndex += 1;
          this.eventCursor = 0;
          this.logEntries.push({
            type: 'loop',
            seq: ++this.seq,
            atMs: this.clockMs,
            tick: this.tick,
            stateId: state.id,
            loopIndex: this.loopIndex,
          });
          this.fireTimeZeroEvents(events);
        } else {
          break;
        }
      }
      return;
    }

    if (this.finished) {
      // 一次性动作已结束: 时钟继续走, 动作与事件保持冻结。
      this.clockMs += dt;
      return;
    }

    const available = state.durationMs - this.stateElapsedMs;
    const step = Math.min(dt, available);
    this.advanceSegment(step, events);
    if (this.stateElapsedMs >= state.durationMs - EPS) {
      this.stateElapsedMs = state.durationMs;
      this.finished = true;
    }
    const rest = dt - step;
    if (rest > EPS) this.clockMs += rest;
  }

  private advanceSegment(step: number, events: OrderedEvent[]): void {
    if (step <= EPS) return;
    const fromLocal = this.stateElapsedMs;
    const toLocal = fromLocal + step;
    const segmentClockStart = this.clockMs;

    while (
      this.eventCursor < events.length &&
      events[this.eventCursor].event.timeMs <= toLocal + EPS
    ) {
      const { event } = events[this.eventCursor];
      const offset = Math.max(0, event.timeMs - fromLocal);
      this.emitEvent(event, segmentClockStart + offset);
      this.eventCursor += 1;
    }

    this.stateElapsedMs = toLocal;
    this.stateTimeMs += step;
    this.clockMs += step;
  }

  private emitEvent(event: AnimEvent, atMs: number): void {
    this.logEntries.push({
      type: 'event',
      seq: ++this.seq,
      atMs,
      tick: this.tick,
      stateId: this.state.id,
      eventId: event.id,
      eventName: event.name,
      kind: event.kind,
      localTimeMs: event.timeMs,
      loopIndex: this.loopIndex,
    });

    if (event.kind === 'window-open') {
      if (!this.windowOpen) {
        this.windowOpen = true;
        this.logEntries.push({
          type: 'window',
          seq: ++this.seq,
          atMs,
          tick: this.tick,
          stateId: this.state.id,
          action: 'open',
          reason: 'event',
          eventId: event.id,
        });
      }
    } else if (event.kind === 'window-close') {
      if (this.windowOpen) {
        this.windowOpen = false;
        this.logEntries.push({
          type: 'window',
          seq: ++this.seq,
          atMs,
          tick: this.tick,
          stateId: this.state.id,
          action: 'close',
          reason: 'event',
          eventId: event.id,
        });
      }
    }
  }

  private skippedEventIds(): string[] {
    const events = this.eventsFor(this.state);
    return events.slice(this.eventCursor).map((entry) => entry.event.id);
  }

  private applyTransition(status: TransitionStatus): void {
    const transition = status.transition;
    const from = this.state;
    const target = this.config.states.find((s) => s.id === transition.to);
    if (!target) {
      throw new Error(`过渡 ${transition.id} 指向不存在的状态 ${transition.to}`);
    }

    const skipped = this.skippedEventIds();
    const wasWindowOpen = this.windowOpen;
    const earlyOneShot = !from.loop && !this.finished;

    let consumedAttack = false;
    if (transition.conditions.attackTrigger && this.inputs.pendingAttacks > 0) {
      this.inputs.pendingAttacks -= 1;
      consumedAttack = true;
    }

    this.logEntries.push({
      type: 'transition',
      seq: ++this.seq,
      atMs: this.clockMs,
      tick: this.tick,
      transitionId: transition.id,
      from: from.id,
      to: transition.to,
      priority: transition.priority,
      orderIndex: status.orderIndex,
      consumedAttack,
      waitForProgress: transition.waitForProgress,
      progress: transition.progress,
      atProgress: this.progress(),
      fromElapsedMs: this.stateElapsedMs,
      fromStateTimeMs: this.stateTimeMs,
      skippedEventIds: skipped,
    });

    if (wasWindowOpen) {
      this.windowOpen = false;
      this.logEntries.push({
        type: 'window',
        seq: ++this.seq,
        atMs: this.clockMs,
        tick: this.tick,
        stateId: from.id,
        action: 'close',
        reason: 'state-exit',
        eventId: null,
      });
    }

    if (earlyOneShot || wasWindowOpen) {
      this.logEntries.push({
        type: 'interrupt',
        seq: ++this.seq,
        atMs: this.clockMs,
        tick: this.tick,
        from: from.id,
        to: transition.to,
        skippedEventIds: skipped,
        forcedWindowClose: wasWindowOpen,
      });
    }

    this.lastTransitionId = transition.id;
    this.enterState(target, false, transition.id);
  }

  private pushInput(
    action: 'queue-attack' | 'clear-attacks' | 'speed' | 'hurt',
    detail: string,
  ): void {
    this.logEntries.push({
      type: 'input',
      seq: ++this.seq,
      atMs: this.clockMs,
      tick: this.tick,
      action,
      detail,
    });
  }
}
