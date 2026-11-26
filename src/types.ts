// 共享类型定义。底图只有三种格子：实地 / 空洞 / 固定墙。
// 墙在开局可见；实地与空洞在交卷前对玩家不可见。

export type CellKind = 'solid' | 'empty' | 'wall';

export type Marker = 'safe' | 'void' | 'unknown';

export type ProbeType = 'line' | 'adjacency';

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Cell {
  r: number;
  c: number;
}

/** 关卡定义（内置关卡，布局固定，不随机生成） */
export interface LevelDef {
  id: string;
  name: string;
  brief: string;
  /** 每行字符：'#' 墙 | 'o' 空洞 | '.' 实地 */
  rows: string[];
  /** 可进入的边：起点与终点 */
  entry: Cell;
  exit: Cell;
  lineBudget: number;
  adjacencyBudget: number;
  /** 设计好的探测序列，供本地校验验证“这套读数能唯一确定底图” */
  walkthrough: ProbeAction[];
  /** 设计好的安全通路，供校验 */
  safePath: Cell[];
}

export interface ProbeAction {
  type: ProbeType;
  r: number;
  c: number;
  /** 方向探头必填 */
  dir?: Direction;
}

/** 一次实际探测的存档：覆盖了哪些格、读数是多少 */
export interface ProbeRecord extends ProbeAction {
  id: number;
  /** 方向探头：连续格中的实地数；邻域探头：有洞=1 / 无洞=0 */
  reading: number;
  cells: Cell[];
}
