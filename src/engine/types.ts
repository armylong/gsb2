// 潮间带信片试验 —— 核心类型定义

/** 高程：0 最低，4 最高礁脊；水位用同一标尺 */
export type Height = 0 | 1 | 2 | 3 | 4;

export type CardKind = 'light' | 'heavy';

export interface CellDef {
  id: string;
  name: string;
  /** canvas 网格坐标（单位：格） */
  x: number;
  y: number;
  height: Height;
}

export interface EdgeDef {
  a: string;
  b: string;
  /** 路面高程：水位 >= 该值时路被淹没封闭 */
  height: Height;
  note?: string;
}

export interface PostcardDef {
  id: string;
  kind: CardKind;
  /** 所在格子 id */
  cell: string;
  label: string;
}

/** 潮汐曲线控制点（一个周期内），相邻点之间线性插值 */
export interface TidePoint {
  t: number;
  level: number;
}

export interface LevelDef {
  name: string;
  /** 潮汐周期（刻） */
  tidePeriod: number;
  cells: CellDef[];
  edges: EdgeDef[];
  postcards: PostcardDef[];
  /** 家 / 信箱格 */
  home: string;
  /** 出生格 */
  start: string;
}

export type RunStatus = 'running' | 'success' | 'stranded' | 'ruined';

export interface LogEntry {
  /** 发生时刻（刻，绝对时间） */
  t: number;
  kind:
    | 'start'
    | 'move'
    | 'interrupt'
    | 'retreat'
    | 'wait'
    | 'wet'
    | 'pickup'
    | 'deliver'
    | 'refuse'
    | 'fail'
    | 'reset';
  text: string;
}

/** 一次移动的动画 / 过程信息，供 canvas 绘制 */
export interface Motion {
  edge: EdgeDef;
  from: string;
  to: string;
  startTick: number;
  duration: number;
  /** 被潮水打断的刻（undefined 表示走完整段） */
  interruptedAt?: number;
  retreatTo?: string;
  retreatDuration?: number;
}

export interface RunRecord {
  id: string;
  startedAt: string;
  endedAt: string;
  outcome: RunStatus;
  /** 取件时刻表：卡片 id -> 刻 */
  pickupTicks: Record<string, number>;
  /** 交件时刻表：卡片 id -> 刻 */
  deliverTicks: Record<string, number>;
  /** 总等待刻数 */
  waitedTicks: number;
  /** 总耗时（刻） */
  totalTicks: number;
  /** 受淹刻数峰值 */
  maxWetTicks: number;
  interruptCount: number;
  log: LogEntry[];
}
