/**
 * 织带拼图核心类型。
 * 棋盘是 (width+1) × (height+1) 个格点，格点之间沿水平/垂直格边走带。
 * 彩带只允许在同一条格边上由一种颜色独占；交叉发生在格点上（两条带各占一对对边）。
 */

/** 颜色标识，同时也是题面中端口、目标花纹的颜色键。 */
export type Color = string;

/** 格点坐标，x 向右、y 向下，均为闭区间 [0, 维度] 内的整数。 */
export interface Vertex {
  x: number;
  y: number;
}

/** 边框上的入口或出口，每个端口绑定唯一颜色。 */
export interface Port {
  vertex: Vertex;
  color: Color;
  /** 同一颜色的两个端口：一个 entry、一个 exit。 */
  kind: 'entry' | 'exit';
  label: string;
}

/** 目标花纹：要求某交叉点上哪种颜色露在顶层。 */
export interface Target {
  vertex: Vertex;
  color: Color;
}

/** 静态题面：织框尺寸、端口、禁用孔和目标花纹。 */
export interface Puzzle {
  id: string;
  name: string;
  width: number;
  height: number;
  ports: Port[];
  /** 禁用孔所在格点，任何带都不得进入。 */
  holes: Vertex[];
  targets: Target[];
  /** 题面自带的开局布局（含上下关系），用于「两个相邻冲突」题面。 */
  initial?: GameState;
  hint: string;
}

/**
 * 一局进行中的布局。
 * edges 的键是无向格边键（见 geometry.ts），值为占用该边的颜色。
 * tops 的键是交叉点格点键，值为玩家指定的顶层颜色；未指定则由引擎按端口序自动裁定。
 */
export interface GameState {
  puzzleId: string;
  edges: Record<string, Color>;
  tops: Record<string, Color>;
}

/** 一条彩带的结构诊断。 */
export interface RibbonDiagnosis {
  color: Color;
  /** 完整连通：恰好由一个连通分量从入口走到出口。 */
  complete: boolean;
  /** 该颜色经过的全部格点（完整时为按入口→出口排序的路径）。 */
  vertices: Vertex[];
  /** 该颜色按顺序经过的交叉点。 */
  crossings: Vertex[];
  /** 结构问题：断头（非端口端点）。 */
  deadEnds: Vertex[];
  /** 结构问题：分叉点（度数 > 2）。 */
  branches: Vertex[];
  /** 结构问题：多个互不相连的分量（每段给一个端点摘要）。 */
  fragments: Vertex[][];
  /** 入口或出口没有接上该颜色。 */
  openPorts: Vertex[];
}

/** 交叉点诊断。 */
export interface CrossingDiagnosis {
  vertex: Vertex;
  /** 交叉的两种颜色。 */
  colors: Color[];
  /** 结构合法（双方各占一对对边，可表达上下穿压）。 */
  valid: boolean;
  /** 顶层颜色：玩家指定优先，否则按端口声明序自动裁定。 */
  top: Color | null;
  bottom: Color | null;
  /** 目标要求的顶层颜色（无目标为 null）。 */
  target: Color | null;
  /** 目标是否满足（无目标视为满足）。 */
  targetMet: boolean;
  /** 该点是否被某条带的上下相间冲突覆盖。 */
  inConflict: boolean;
}

/** 一个格点上的当前判断，用于「点击格子看判断」。 */
export type CellStatus =
  | 'empty'
  | 'hole'
  | 'port'
  | 'ribbon'
  | 'crossing'
  | 'invalid-crossing';

export interface CellDiagnosis {
  vertex: Vertex;
  status: CellStatus;
  colors: Color[];
  top: Color | null;
  target: Color | null;
  targetMet: boolean;
  conflict: boolean;
  message: string;
}

/** 一段上下相间冲突：同一条带上相邻两个交叉点的顶层相同。 */
export interface ConflictSegment {
  color: Color;
  from: Vertex;
  to: Vertex;
  /** 从 from 到 to 的格点序列，用于高亮「真正有冲突的一段」。 */
  path: Vertex[];
}

/** 目标点检查结果（只完成一部分时也照常给出）。 */
export interface TargetCheck {
  vertex: Vertex;
  expected: Color;
  actual: Color | null;
  /** ok：当前已满足；mismatch：顶层颜色不对；pending：此处还没形成交叉。 */
  state: 'ok' | 'mismatch' | 'pending';
}

/** 整局诊断结果。 */
export interface Diagnosis {
  /** 每种颜色一条。 */
  ribbons: RibbonDiagnosis[];
  /** 结构不合法的交叉点（非对边占用、超过两色等）。 */
  invalidCrossings: Vertex[];
  crossings: CrossingDiagnosis[];
  conflicts: ConflictSegment[];
  conflictEdges: string[];
  targets: TargetCheck[];
  /** 每条带都完整 + 无结构问题 + 无相间冲突 + 全部目标满足。 */
  solved: boolean;
  /** 人类可读的问题清单，用于侧栏。 */
  problems: string[];
}
