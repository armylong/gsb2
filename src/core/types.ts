// 核心类型定义

/** 地形 / 区域类型 */
export enum Zone {
  Block = 0, // 不可走：岩石、灌木
  Normal = 1, // 可走：普通积雪
  Wind = 2, // 迎风口：新雪覆盖极快
  Shelter = 3, // 避风区：积雪很慢，足迹保存久
}

/** 四方向（脚步朝向下一个格子的方向） */
export enum Dir {
  N = 0,
  E = 1,
  S = 2,
  W = 3,
}

export const DIR_VECTORS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], // N
  [1, 0], // E
  [0, 1], // S
  [-1, 0], // W
];

export const DIR_NAMES: Record<Dir, string> = {
  [Dir.N]: '北',
  [Dir.E]: '东',
  [Dir.S]: '南',
  [Dir.W]: '西',
};

/** 观察到的可见等级 */
export enum Visibility {
  Gone = 0, // 已被新雪完全盖住，看不见
  Trace = 1, // 浅痕：只剩压痕，方向与重量不可读
  Visible = 2, // 较新脚印：可读出方向与深浅
}

/** 深浅档位（观察结果，玩家可见的离散描述） */
export enum DepthLevel {
  Trace = 0, // 浅痕（不可读深浅）
  Light = 1, // 浅
  Medium = 2, // 中
  Deep = 3, // 深
}

export const DEPTH_NAMES: Record<DepthLevel, string> = {
  [DepthLevel.Trace]: '浅痕',
  [DepthLevel.Light]: '浅',
  [DepthLevel.Medium]: '中',
  [DepthLevel.Deep]: '深',
};

/** 单个足迹的内部表示 */
export interface Impression {
  /** 所属路线 id */
  routeId: number;
  /** 路线内的步序 */
  step: number;
  /** 落脚方向（朝向下一格；最后一步为行进末端，方向为末段方向） */
  dir: Dir;
  /** 重量档位，决定初始压深 */
  weight: number;
  /** 落脚时刻（游戏内分钟） */
  time: number;
  /** 初始压深（含确定性抖动），0~1 */
  initialDepth: number;
  /** 该格此足迹所在区域的积雪速率（含格内确定性抖动） */
  coverRate: number;
}

/** 观察时一格里可见的单条足迹信息（玩家可见） */
export interface VisibleImpression {
  routeId: number;
  step: number;
  dir: Dir | null; // Trace 时为 null
  depth: DepthLevel;
  visibility: Visibility;
  cover: number; // 当前覆盖率 0~1，仅用于调试/教学面板
  initialDepth: number;
  time: number;
}

/** 一次观察记录 */
export interface Observation {
  x: number;
  y: number;
  /** 观察时的游戏时刻 */
  atTime: number;
  /** 踩入(true)还是扫雪(false)；扫雪对浅痕的把握更低 */
  stepped: boolean;
  impressions: VisibleImpression[];
}

/** 推断链中的一条目：观察格 */
export interface ChainObsEntry {
  kind: 'obs';
  x: number;
  y: number;
  /** 叠踩格中玩家选定的是第几条可见足迹（按时间从新到旧排序后的下标） */
  pick: number;
}

/** 推断链中的一条目：跳过的不确定格 */
export interface ChainGapEntry {
  kind: 'gap';
}

export type ChainEntry = ChainObsEntry | ChainGapEntry;

/** 路线定义 */
export interface RouteDef {
  id: number;
  name: string;
  /** 途经格子坐标序列（相邻正交） */
  cells: Array<[number, number]>;
  /** 重量档位 */
  weight: number;
  /** 第一步的落脚时刻 */
  startTime: number;
  /** 每步间隔（分钟） */
  interval: number;
}

/** 题面定义 */
export interface ScenarioDef {
  id: string;
  title: string;
  description: string;
  width: number;
  height: number;
  zones: Zone[][]; // zones[y][x]
  routes: RouteDef[];
  playerStart: [number, number];
  /** 游戏开始时距离最早足迹的分钟数 */
  initialTime: number;
  /** 随机种子；同种子重开完全复现 */
  seed: string;
}
