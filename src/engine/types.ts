/**
 * 核心类型定义。物理引擎只依赖这些纯数据结构，不接触 DOM / Canvas，
 * 因此同一份规则可以同时驱动页面交互、脚本演示和自动化测试。
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** 单帧输入：方向为意图（-1/0/1），jumpPressed 为本步内“新按下”的边沿事件 */
export interface InputState {
  move: number;
  jumpPressed: boolean;
}

/** 可调手感参数（均为物理世界单位：px、秒、px/s、px/s²） */
export interface TunableParams {
  /** 水平最大移动速度 px/s */
  moveSpeed: number;
  /** 地面水平加速度 px/s² */
  groundAccel: number;
  /** 地面水平减速度（松键回中）px/s² */
  groundDecel: number;
  /** 空中水平加速度 px/s² */
  airAccel: number;
  /** 空中水平减速度 px/s² */
  airDecel: number;
  /** 重力加速度 px/s²（向下为正） */
  gravity: number;
  /** 起跳瞬间获得的向上速度 px/s（向上为负） */
  jumpSpeed: number;
  /** 离地后仍可起跳的宽限时间（土狼时间）秒 */
  coyoteTime: number;
  /** 落地前提前按跳跃的缓冲时间秒 */
  jumpBufferTime: number;
  /** 站在移动平台上起跳 / 移动时是否继承平台速度 */
  inheritPlatformVelocity: boolean;
}

export const DEFAULT_PARAMS: TunableParams = {
  moveSpeed: 260,
  groundAccel: 2200,
  groundDecel: 2600,
  airAccel: 1400,
  airDecel: 900,
  gravity: 1500,
  jumpSpeed: 560,
  coyoteTime: 0.1,
  jumpBufferTime: 0.12,
  inheritPlatformVelocity: true,
};

/** 轴对齐矩形碰撞体 */
export interface AABB {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SolidKind = 'ground' | 'wall' | 'ceiling' | 'step' | 'platform';

/** 引擎步进时实际参与碰撞的实体（每帧由静态配置 + 平台位置生成） */
export interface Solid extends AABB {
  id: string;
  kind: SolidKind;
  /** 本帧速度；静态物体为 0 */
  vx: number;
  vy: number;
  /** 是否为移动平台（支撑关系只在这类物体上做速度继承） */
  moving: boolean;
  label: string;
}

/** 移动平台的往返配置 */
export interface PlatformDef {
  id: string;
  label: string;
  w: number;
  h: number;
  /** 静止时左上角坐标 */
  baseX: number;
  baseY: number;
  axis: 'horizontal' | 'vertical';
  /** 单程振幅 px（base ± range） */
  range: number;
  /** 单程耗时秒 */
  halfPeriod: number;
}

/** 静态场地配置 */
export interface StaticDef extends AABB {
  id: string;
  kind: Exclude<SolidKind, 'platform'>;
  label: string;
}

export interface WorldPreset {
  width: number;
  height: number;
  player: { x: number; y: number; w: number; h: number };
  statics: StaticDef[];
  platforms: PlatformDef[];
}

export type ContactSide = 'left' | 'right' | 'up' | 'down';

/** 接触变化事件（演示与手动操作共用同一记录格式） */
export type SimEventType =
  | 'land'
  | 'leave'
  | 'support-switch'
  | 'head-bump'
  | 'jump'
  | 'coyote-jump'
  | 'buffered-jump'
  | 'platform-reverse';

export interface SimEvent {
  /** 引擎累计模拟时间（秒），固定步长整数倍 */
  t: number;
  /** 引擎步数序号 */
  step: number;
  type: SimEventType;
  detail: string;
}

export interface PlayerState {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  grounded: boolean;
  /** 当前脚下支撑实体 id（静止地面/台阶/移动平台） */
  groundId: string | null;
  /** 上一帧的支撑 id，用于支撑切换事件 */
  prevGroundId: string | null;
  /** 本帧四个方向的接触标记，供 HUD / 绘制 */
  contacts: Record<ContactSide, boolean>;
  coyoteTimer: number;
  jumpBufferTimer: number;
  /** 当前跳跃是否已经消耗过一次按下事件 */
  jumpConsumed: boolean;
}

export interface SimState {
  time: number;
  step: number;
  params: TunableParams;
  player: PlayerState;
  solids: Solid[];
  events: SimEvent[];
}

/** 固定模拟步长：物理恒为 60Hz，与显示节奏解耦 */
export const FIXED_DT = 1 / 60;

/** 事件记录环形缓冲上限，避免长时间运行后无限增长 */
export const EVENT_LIMIT = 300;
