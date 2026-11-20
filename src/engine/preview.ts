import { AnimationMachine } from './machine';
import { evaluateTransitions, normalizeInputs, orderedEvents } from './select';
import type {
  AnimState,
  MachineConfig,
  MachineInputs,
  TransitionStatus,
} from './types';

/**
 * 预览器: 只沿时间线展示动作形状与事件位置, 不驱动真实状态机。
 * 它没有日志、待处理攻击队列和攻击窗口, 因此不可能消费输入或触发窗口。
 */
export interface PreviewFrame {
  state: AnimState;
  /** 预览冻结在状态内的局部时间 */
  elapsedMs: number;
  stateTimeMs: number;
  loopIndex: number;
  progress: number;
  /** 已经"经过"的事件(仅用于高亮) */
  passedEventIds: string[];
  upcomingEventIds: string[];
  /** 该状态在预览时间轴上的总长度 */
  rangeMs: number;
}

/** 纯函数版本: 预览时间轴与真实状态机共享配置, 但不共享任何可变状态。 */
export function buildPreviewFrame(
  config: MachineConfig,
  stateId: string,
  timeMs: number,
): PreviewFrame {
  const state = config.states.find((s) => s.id === stateId) ?? config.states[0];
  if (!state) {
    throw new Error('配置没有状态, 无法预览');
  }
  const safeTime = Math.max(0, Number.isFinite(timeMs) ? timeMs : 0);
  const loopIndex = state.loop ? Math.floor(safeTime / state.durationMs) : 0;
  const elapsedMs = state.loop
    ? safeTime % state.durationMs
    : Math.min(safeTime, state.durationMs);
  const stateTimeMs = state.loop ? safeTime : elapsedMs;
  const passedEventIds: string[] = [];
  const upcomingEventIds: string[] = [];
  for (const { event } of orderedEvents(state)) {
    if (event.timeMs <= elapsedMs) passedEventIds.push(event.id);
    else upcomingEventIds.push(event.id);
  }
  return {
    state,
    elapsedMs,
    stateTimeMs,
    loopIndex,
    progress: state.durationMs > 0 ? Math.min(1, elapsedMs / state.durationMs) : 1,
    passedEventIds,
    upcomingEventIds,
    rangeMs: state.durationMs * (state.loop ? 3 : 1),
  };
}

export class PreviewTimeline {
  private machine: AnimationMachine;
  private stateId: string;
  private timeMs: number;

  constructor(config: MachineConfig, stateId?: string, timeMs = 0) {
    this.machine = new AnimationMachine(config, {
      initialStateId: stateId,
      initialInputs: {},
    });
    this.stateId = this.machine.currentStateId;
    this.timeMs = Math.max(0, Number.isFinite(timeMs) ? timeMs : 0);
  }

  get state(): AnimState {
    return this.machine.getSnapshot().state;
  }

  seek(timeMs: number): void {
    this.timeMs = Math.max(0, Number.isFinite(timeMs) ? timeMs : 0);
  }

  setState(stateId: string): void {
    const config = this.machine.configRef;
    if (!config.states.some((s) => s.id === stateId)) return;
    this.machine = new AnimationMachine(config, {
      initialStateId: stateId,
      initialInputs: {},
    });
    this.stateId = stateId;
    this.timeMs = 0;
  }

  get frame(): PreviewFrame {
    return buildPreviewFrame(this.machine.configRef, this.stateId, this.timeMs);
  }
}

/** 预览求值专用的只读辅助, 供 UI 显示"若在此刻评估"的候选。 */
export function previewTransitionStatuses(
  config: MachineConfig,
  state: AnimState,
  elapsedMs: number,
  inputs: MachineInputs,
): { statuses: TransitionStatus[]; winner: TransitionStatus | null } {
  const result = evaluateTransitions(
    config,
    state.id,
    normalizeInputs(inputs),
    elapsedMs,
    state.durationMs,
    false,
  );
  return { statuses: result.statuses, winner: result.winner };
}
