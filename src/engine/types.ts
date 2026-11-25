/**
 * 温室传粉配色 —— 核心类型定义
 *
 * 设计原则：引擎是 Board -> TurnReport 的纯函数，不依赖 DOM / Canvas，
 * 所有“同一输入必然得到同一输出”的性质都可以直接在 node 里测试。
 */

/** 风向（8 邻格 + 正交四向；本题场景里主要用到正交与对角） */
export type Direction = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export const DIRECTION_VECTORS: Readonly<Record<Direction, { dx: number; dy: number }>> = {
  N: { dx: 0, dy: -1 },
  NE: { dx: 1, dy: -1 },
  E: { dx: 1, dy: 0 },
  SE: { dx: 1, dy: 1 },
  S: { dx: 0, dy: 1 },
  SW: { dx: -1, dy: 1 },
  W: { dx: -1, dy: 0 },
  NW: { dx: -1, dy: -1 },
};

/**
 * 颜色 = 三原色（颜料/减法混色）位掩码。
 * 混色规则是集合取并集（按位或），因此 A+B 与 B+A 完全相同，
 * 不会因为遍历风或花朵的绘制顺序而得到不同结果。
 */
export const PRIMARY = {
  R: 1 << 0, // 红
  Y: 1 << 1, // 黄
  B: 1 << 2, // 蓝
} as const;

export type ColorCode = number;

export const COLOR_NONE: ColorCode = 0;

/** 同一种颜色需要连续收到多少轮才会稳定成花朵自身颜色 */
export const STABLE_TURNS = 3;

/** 风的种类：决定花粉能飞几格 */
export type WindKind = 'breeze' | 'gale';

export const WIND_RANGE: Readonly<Record<WindKind, number>> = {
  breeze: 1, // 微风：只送到相邻一格
  gale: 2, // 疾风：沿同方向连飞两格
};

export interface Cell {
  x: number;
  y: number;
}

export interface Flower extends Cell {
  id: string;
  /** 当前稳定颜色（位掩码）；COLOR_NONE 表示白色未着色 */
  color: ColorCode;
  /**
   * 正在积累的目标色（位掩码）；COLOR_NONE 表示没有积累。
   * 连续收到同色 STABLE_TURNS 轮后会写入 color。
   */
  pendingColor: ColorCode;
  /** 已连续积累的轮数，范围 0..STABLE_TURNS */
  progress: number;
}

/** 风从 from 格出发，沿 dir 吹，把起点花朵的花粉带向沿途格子 */
export interface Wind {
  id: string;
  from: Cell;
  dir: Direction;
  kind: WindKind;
}

/** 挡风板：占据一个格子，花粉进入该格即被拦截，不会继续向后飞 */
export interface Panel {
  id: string;
  x: number;
  y: number;
}

export interface Board {
  width: number;
  height: number;
  flowers: Flower[];
  winds: Wind[];
  panels: Panel[];
}

/** 单条花粉路径上的一格 */
export interface TraceStep extends Cell {
  /** 是否被挡风板拦截在这一格 */
  blocked: boolean;
  /** 这一格上是否有花（被拦截时也可能有花：先拦截、不投递） */
  hasFlower: boolean;
}

/** 一次成功落到某朵花上的花粉来源 */
export interface Arrival {
  flowerId: string;
  sourceFlowerId: string;
  sourceColor: ColorCode;
  windId: string;
  steps: TraceStep[];
}

/** 一朵花本轮收到花粉后的结算明细，供“点花查看来源”使用 */
export interface FlowerTurnDetail {
  flowerId: string;
  beforeColor: ColorCode;
  /** 本轮到达的全部花粉（按来源花 id 排序，顺序确定） */
  arrivals: Arrival[];
  /** 各来源颜色按位或得到的混合色；无来源时为 COLOR_NONE */
  incomingColor: ColorCode;
  /** 结算前的积累状态 */
  beforePendingColor: ColorCode;
  beforeProgress: number;
  /** 结算后的积累状态 */
  afterPendingColor: ColorCode;
  afterProgress: number;
  afterColor: ColorCode;
  /** 本轮是否发生了稳定变色 */
  stabilized: boolean;
}

export interface TurnReport {
  round: number;
  details: FlowerTurnDetail[];
  /** 每条风的路径（含被拦截的路径），用于画布绘制，顺序与 board.winds 一致 */
  traces: { windId: string; steps: TraceStep[]; delivered: boolean }[];
  board: Board;
}
