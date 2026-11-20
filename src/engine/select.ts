import type {
  AnimEvent,
  AnimState,
  BlockReason,
  MachineConfig,
  MachineInputs,
  Transition,
  TransitionConditions,
  TransitionStatus,
} from './types';

export interface EvaluationResult {
  statuses: TransitionStatus[];
  /** 优先级最高且条件全满足的过渡; 同优先级时取 transitions 数组靠前者 */
  winner: TransitionStatus | null;
  progress: number;
}

/**
 * 过渡选择:
 * 1. 依次检查速度 / 受击 / 攻击触发 / 等待进度, 全部满足才 eligible;
 * 2. eligible 的按 priority 降序, 同优先级按 transitions 数组顺序;
 * 3. 只有 winner 会被采用, 也只有它会消耗攻击触发。
 */
export function evaluateTransitions(
  config: MachineConfig,
  fromStateId: string,
  inputs: Required<MachineInputs>,
  stateElapsedMs: number,
  stateDurationMs: number,
  stateFinished: boolean,
): EvaluationResult {
  const candidates = config.transitions
    .map((transition, orderIndex) => ({ transition, orderIndex }))
    .filter((c) => c.transition.from === fromStateId);

  const progress =
    stateDurationMs > 0 ? clamp01(stateElapsedMs / stateDurationMs) : 1;

  const statuses: TransitionStatus[] = candidates.map(({ transition, orderIndex }) => {
    const reasons = blockReasons(transition, inputs, progress, stateFinished);
    return {
      transition,
      orderIndex,
      eligible: reasons.length === 0,
      reasons,
      currentProgress: progress,
      selectionRank: null,
    };
  });

  const eligible = statuses
    .filter((s) => s.eligible)
    .sort((a, b) => {
      if (b.transition.priority !== a.transition.priority) {
        return b.transition.priority - a.transition.priority;
      }
      return a.orderIndex - b.orderIndex;
    });

  eligible.forEach((status, rank) => {
    status.selectionRank = rank;
  });

  return { statuses, winner: eligible[0] ?? null, progress };
}

export function blockReasons(
  transition: Transition,
  inputs: Required<MachineInputs>,
  progress: number,
  stateFinished: boolean,
): BlockReason[] {
  const reasons: BlockReason[] = [];
  if (!conditionSpeed(transition.conditions, inputs.speed)) reasons.push('speed');
  if (!conditionHurt(transition.conditions, inputs.hurt)) reasons.push('hurt');
  if (transition.conditions.attackTrigger && inputs.pendingAttacks <= 0) {
    reasons.push('attack-trigger');
  }
  if (!progressReached(transition, progress, stateFinished)) reasons.push('wait-progress');
  return reasons;
}

export function progressReached(
  transition: Transition,
  progress: number,
  stateFinished: boolean,
): boolean {
  if (!transition.waitForProgress) return true;
  if (stateFinished) return true;
  return progress + 1e-9 >= transition.progress;
}

export function conditionSpeed(conditions: TransitionConditions, speed: number): boolean {
  if (!conditions.speed) return true;
  return conditions.speed.op === 'gte'
    ? speed >= conditions.speed.value
    : speed <= conditions.speed.value;
}

export function conditionHurt(conditions: TransitionConditions, hurt: boolean): boolean {
  if (conditions.hurt === null) return true;
  return conditions.hurt === hurt;
}

/**
 * 稳定事件顺序: 先按时间; 同一时刻按事件在数组中的原始位置。
 * 使用索引而非 sort 的稳定性推断, 保证跨运行时一致。
 */
export function orderedEvents(state: AnimState): Array<{ event: AnimEvent; index: number }> {
  return state.events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      if (a.event.timeMs !== b.event.timeMs) return a.event.timeMs - b.event.timeMs;
      return a.index - b.index;
    });
}

export function findState(config: MachineConfig, stateId: string): AnimState | undefined {
  return config.states.find((s) => s.id === stateId);
}

export function normalizeInputs(inputs: MachineInputs): Required<MachineInputs> {
  return {
    speed: inputs.speed ?? 0,
    hurt: inputs.hurt ?? false,
    pendingAttacks: inputs.pendingAttacks ?? 0,
  };
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
