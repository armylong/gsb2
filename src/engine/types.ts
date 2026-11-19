// 引擎层与 DOM / Canvas 完全无关, 可直接在 Node 下用 vitest 验证

export type NodeStatus = 'idle' | 'running' | 'success' | 'failure' | 'interrupted';
export type NodeKind = 'selector' | 'guard' | 'sequence' | 'condition' | 'action';
export type NodeResult = 'running' | 'success' | 'failure';

export interface Vec {
  x: number;
  y: number;
}

export type MoveRef =
  | { kind: 'point'; index: number } // 巡逻点 / 休息点(静态)
  | { kind: 'target' }; // 可拖动目标(动态, 每个 tick 重新取坐标)

export interface MoveTarget {
  pos: Vec;
  ref: MoveRef;
  /** 当前持有移动目标的动作实例 id; 中断时由原动作自行清空, 防止旧动作残留控制 */
  ownerActionId: number;
}

export type LogKind = 'enter' | 'exit' | 'interrupt' | 'info';

export interface LogEntry {
  id: number;
  tick: number;
  simTime: number;
  nodeId: number;
  nodeName: string;
  kind: LogKind;
  detail: string;
}

export type BranchId = 'retreat' | 'chase' | 'patrol' | 'idle';

export interface SimConfig {
  lowHpThreshold: number; // 低生命撤退阈值
  alertRange: number; // 警戒范围(世界单位)
  patrolEnabled: boolean; // 巡逻开关(条件)
  patrolWait: number; // 巡逻点等待时长(s)
  restWait: number; // 休息点等待时长(s)
  /** 根优先选择节点的分支顺序, 索引 0 = 最高优先; idle 永远钉在最后 */
  branchOrder: BranchId[];
}

export const TICK_SECONDS = 0.5;
