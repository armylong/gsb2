// 群岛潮汐传送 —— 基础类型定义

/** 潮汐卡两面：潮(正面) / 汐(反面) */
export type Side = 'tide' | 'ebb';

/** 四方向（屏幕坐标系，北为 y 减小的方向） */
export type Dir = 'N' | 'E' | 'S' | 'W';

/** 某一卡面下门的规则；null 表示该卡面下此门不接受通行 */
export interface GateRule {
  /** 目标岛 */
  toIsland: string;
  /** 目标岛的落点入口 id */
  toGate: string;
  /** 通过后是否翻卡 */
  flip: boolean;
}

/** 岛上的门。sealed=true 表示这是别的岛单向门的“背面”，本侧不可通过 */
export interface Gate {
  id: string;
  islandId: string;
  name: string;
  /** 门在岛上的朝向（入口面朝的方向） */
  dir: Dir;
  /** 门在画布上的像素坐标 */
  x: number;
  y: number;
  /** true = 只许出去的门的背面：画成封死栅栏，不可进入 */
  sealed: boolean;
  /** 单向门：只能从正面出去，背面是 sealed 落点 */
  oneWay: boolean;
  tide: GateRule | null;
  ebb: GateRule | null;
}

export interface Island {
  id: string;
  name: string;
  subtitle: string;
  /** 岛上有潮钟：可在该岛重新选择卡面 */
  hasClock: boolean;
  /** 岛上有纪念章（题面一的目标） */
  hasMedal: boolean;
  /** 岛内可走区域中心与半径（圆形小岛） */
  cx: number;
  cy: number;
  radius: number;
  gates: Gate[];
}

export interface Puzzle {
  id: string;
  title: string;
  brief: string;
  startIsland: string;
  startSide: Side;
  /** 题面目标岛 */
  goalIsland: string;
  /** 是否以纪念章作为目标（用于完成判定） */
  goalIsMedal: boolean;
}

/** 玩家运行期状态 */
export interface PlayerState {
  islandId: string;
  x: number;
  y: number;
  facing: Dir;
  side: Side;
  medalTaken: boolean;
}

export interface LogEntry {
  n: number;
  text: string;
  kind: 'move' | 'block' | 'clock' | 'goal' | 'info';
}

/** 一次门通行的完整落点信息（用于每次过门后的核对） */
export interface TransitInfo {
  fromIsland: string;
  fromGate: string;
  fromGateName: string;
  sideBefore: Side;
  flipped: boolean;
  sideAfter: Side;
  toIsland: string;
  toGate: string;
  toGateName: string;
  facingAfter: Dir;
}

/** 图上的一个状态 = 岛 + 卡面 */
export type GraphState = string; // `${islandId}:${Side}`
