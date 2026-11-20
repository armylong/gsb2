/**
 * 动画状态机的纯数据模型。
 *
 * 时间统一使用整数毫秒, 便于确定性重跑与事件记录核对。
 */

export type EventKind = 'footstep' | 'window-open' | 'window-close' | 'marker';

/** 几何角色的动作形态; 与状态 id 解耦, 载入自定义配置时仍能画出可辨认的动作。 */
export type PoseKind = 'idle' | 'run' | 'attack' | 'hurt' | 'victory';

export interface AnimEvent {
  id: string;
  name: string;
  kind: EventKind;
  /** 相对当前状态开始的时间, 必须满足 0 <= timeMs < durationMs */
  timeMs: number;
}

export interface AnimState {
  id: string;
  name: string;
  /** 单次动作时长(毫秒), > 0 */
  durationMs: number;
  loop: boolean;
  visual: PoseKind;
  events: AnimEvent[];
}

export type SpeedOp = 'gte' | 'lte';

export interface SpeedCondition {
  op: SpeedOp;
  value: number;
}

export interface TransitionConditions {
  /** null 表示不检查速度 */
  speed: SpeedCondition | null;
  /** null 表示不检查受击; true 要求当前受击, false 要求当前非受击 */
  hurt: boolean | null;
  /** 为 true 时要求存在待处理攻击触发, 且过渡被采用时消耗一次 */
  attackTrigger: boolean;
}

export interface Transition {
  id: string;
  from: string;
  to: string;
  /** 数值越大越优先 */
  priority: number;
  /** 是否等待当前动作到达 progress 指定的进度 */
  waitForProgress: boolean;
  /** 0..1, waitForProgress=false 时忽略 */
  progress: number;
  conditions: TransitionConditions;
}

export interface MachineConfig {
  version: 1;
  name: string;
  initialState: string;
  states: AnimState[];
  transitions: Transition[];
}

export type BlockReason = 'wait-progress' | 'speed' | 'hurt' | 'attack-trigger';

export interface TransitionStatus {
  transition: Transition;
  /** 在 transitions 数组中的稳定次序, 从 0 开始 */
  orderIndex: number;
  eligible: boolean;
  reasons: BlockReason[];
  currentProgress: number;
  /** 满足条件的过渡中的选择次序, 0 为最先; 不满足时为 null */
  selectionRank: number | null;
}

export interface MachineInputs {
  speed?: number;
  hurt?: boolean;
  pendingAttacks?: number;
}

export interface MachineSnapshot {
  configName: string;
  state: AnimState;
  stateId: string;
  stateName: string;
  /** 当前动作内的局部时间(循环状态每圈归零) */
  elapsedMs: number;
  /** 自进入当前状态以来的总时间, 循环状态会超过单次时长 */
  stateTimeMs: number;
  progress: number;
  loopIndex: number;
  finished: boolean;
  attackWindowOpen: boolean;
  pendingAttacks: number;
  speed: number;
  hurt: boolean;
  clockMs: number;
  tick: number;
  lastTransitionId: string | null;
  transitionStatuses: TransitionStatus[];
  log: readonly LogEntry[];
  /** 日志条数; 日志数组本身按追加更新, UI 用它作为失效信号 */
  logLength: number;
}

export type LogEntry =
  | {
      type: 'reset';
      seq: number;
      atMs: number;
      tick: number;
      stateId: string;
      speed: number;
      hurt: boolean;
      pendingAttacks: number;
    }
  | {
      type: 'input';
      seq: number;
      atMs: number;
      tick: number;
      action: 'queue-attack' | 'clear-attacks' | 'speed' | 'hurt';
      detail: string;
    }
  | {
      type: 'state-enter';
      seq: number;
      atMs: number;
      tick: number;
      stateId: string;
      stateName: string;
      initial: boolean;
      loopIndex: number;
      transitionId: string | null;
    }
  | {
      type: 'transition';
      seq: number;
      atMs: number;
      tick: number;
      transitionId: string;
      from: string;
      to: string;
      priority: number;
      orderIndex: number;
      consumedAttack: boolean;
      waitForProgress: boolean;
      /** 过渡配置要求的进度阈值 */
      progress: number;
      /** 实际切换时源动作所处的进度 */
      atProgress: number;
      /** 实际切换时源动作的局部运行时间 */
      fromElapsedMs: number;
      /** 实际切换时源自进入以来的总时间(循环状态会超过单次时长) */
      fromStateTimeMs: number;
      /** 被切走时, 源状态本轮尚未触发的后续事件 */
      skippedEventIds: string[];
    }
  | {
      type: 'event';
      seq: number;
      atMs: number;
      tick: number;
      stateId: string;
      eventId: string;
      eventName: string;
      kind: EventKind;
      localTimeMs: number;
      loopIndex: number;
    }
  | {
      type: 'window';
      seq: number;
      atMs: number;
      tick: number;
      stateId: string;
      action: 'open' | 'close';
      reason: 'event' | 'state-exit';
      eventId: string | null;
    }
  | {
      type: 'interrupt';
      seq: number;
      atMs: number;
      tick: number;
      from: string;
      to: string;
      skippedEventIds: string[];
      forcedWindowClose: boolean;
    }
  | {
      type: 'loop';
      seq: number;
      atMs: number;
      tick: number;
      stateId: string;
      loopIndex: number;
    };

export type LogType = LogEntry['type'];

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  footstep: '脚步',
  'window-open': '窗口开',
  'window-close': '窗口关',
  marker: '标记',
};

export const LOG_TYPE_LABEL: Record<LogType, string> = {
  reset: '重置',
  input: '输入',
  'state-enter': '进入',
  transition: '过渡',
  event: '实际事件',
  window: '窗口',
  interrupt: '中断',
  loop: '循环',
};

export const BLOCK_REASON_LABEL: Record<BlockReason, string> = {
  'wait-progress': '未到等待进度',
  speed: '速度不满足',
  hurt: '受击条件不满足',
  'attack-trigger': '无待处理攻击触发',
};

export const POSE_KIND_LABEL: Record<PoseKind, string> = {
  idle: '待机',
  run: '跑步',
  attack: '攻击',
  hurt: '受击',
  victory: '胜利',
};
