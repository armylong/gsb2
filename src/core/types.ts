/** 领域类型:网格地图、房间、通道、门、钥匙 */

export const enum Tile {
  Wall = 0,
  Floor = 1, // 房间内部
  Corridor = 2, // 通道
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Room extends Rect {
  id: number;
  name: string;
}

/** 门位于通道格子上(也可能位于房间边缘格子),需要对应颜色钥匙才能通过 */
export interface Door {
  id: number;
  x: number;
  y: number;
  /** 锁色索引 0..2;null = 已移除锁(永久敞开) */
  color: number | null;
  /** 所属通道 id(门一定属于某条通道) */
  corridorId: number;
}

export interface KeyItem {
  id: number;
  color: number;
  x: number;
  y: number;
  /** 当前所在房间 id;不在任何房间内时为 null */
  roomId: number | null;
}

export interface Corridor {
  id: number;
  /** 通道连接的两个房间 */
  roomA: number;
  roomB: number;
  /** 构成通道(含接入房间的端点)的全部格子,按路径顺序排列 */
  cells: Point[];
  /** 是否已被人工移除:移除后格子变回墙 */
  removed: boolean;
}

export interface GameMap {
  version: 1;
  width: number;
  height: number;
  /** 行优先:tiles[y * width + x] */
  tiles: Uint8Array;
  rooms: Room[];
  corridors: Corridor[];
  doors: Door[];
  keys: KeyItem[];
  start: Point;
  exit: Point;
  /** 本次生成使用的锁色数量 0..3 */
  colorCount: number;
  /** 来源种子与参数,保存/恢复时原样带回 */
  seed: string;
  roomCount: number;
}

/** 锁钥分析结论中的单个阻塞门 */
export interface BlockerInfo {
  doorId: number;
  color: number;
  x: number;
  y: number;
  corridorId: number;
  rooms: [number, number];
}

/** 钥匙信息(分析结果用) */
export interface KeyInfo {
  keyId: number;
  color: number;
  x: number;
  y: number;
  roomId: number | null;
  /** 不考虑锁时是否可从起点到达 */
  terrainReachable: boolean;
  /** 考虑锁后是否真的能拿到 */
  obtainable: boolean;
}

export type FailureReason =
  | 'terrain' // 地形断开:出口与起点在忽略锁的情况下也不连通
  | 'missing_key' // 缺钥匙:某颜色的门存在,但整张图没有对应颜色的钥匙
  | 'self_lock' // 钥匙自锁:钥匙被同色门(或依赖循环)挡在后面
  | 'circular'; // 多色依赖环:A 色钥匙在 B 色门后,B 色钥匙又在 A 色门后

export interface FailureDetail {
  reason: FailureReason;
  /** 相关颜色(地形断开时可能为空) */
  colors: number[];
  /** 阻塞门 */
  blockers: BlockerInfo[];
  /** 相关房间 id */
  roomIds: number[];
  /** 中文说明 */
  message: string;
}

/** 路线中的一步 */
export interface RouteStep {
  index: number;
  x: number;
  y: number;
  /** 本步是否经过门(从关闭状态通过,触发开门) */
  openedDoorId: number | null;
  /** 本步踩到的钥匙 id(拿到后永久持有) */
  pickedKeyId: number | null;
  /** 走完本步后持有的钥匙颜色集合 */
  heldColors: number[];
  /** 已打开(不再阻拦)的门 id 集合 */
  openedDoorIds: number[];
}

export interface Route {
  steps: RouteStep[];
  /** 路线中按顺序发生的事件摘要 */
  events: string[];
  length: number;
}

export interface LockAnalysis {
  /** 忽略锁时,起点能到达的全部格子 */
  terrainReachable: Set<number>;
  /** 忽略锁时的连通分量 id(每格一个),不可达格子为 -1 */
  components: Int16Array;
  /** 与起点不连通的房间 id */
  disconnectedRooms: number[];
  /** 与起点不连通的分量(分量 id -> 房间 id 列表) */
  disconnectedComponents: Map<number, number[]>;
  /** 考虑锁与钥匙后,实际可到达的格子 */
  reachable: Set<number>;
  /** 实际可到达的房间 id */
  reachableRooms: number[];
  /** 每种颜色钥匙的获取状态 */
  keyInfos: KeyInfo[];
  exitReachable: boolean;
  /** 出口不可达时的诊断;可达时为 null */
  failure: FailureDetail | null;
  /** 到出口的实际路线;不可达时为 null */
  route: Route | null;
}

/** 颜色定义:索引 0..2,渲染与 UI 共用 */
export const LOCK_COLORS: { name: string; fill: string; stroke: string; chip: string }[] = [
  { name: '红', fill: '#e5484d', stroke: '#ff9b9e', chip: '#e5484d' },
  { name: '蓝', fill: '#3e85f7', stroke: '#9cc1ff', chip: '#3e85f7' },
  { name: '绿', fill: '#35a75c', stroke: '#93e0af', chip: '#35a75c' },
];

export function colorName(color: number): string {
  return LOCK_COLORS[color]?.name ?? `色${color}`;
}
