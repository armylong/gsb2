/**
 * 全局类型定义：场景配置、链节/关节记录、运行时读数。
 */
import type { Body, Joint, RevoluteJoint, Vec2 } from 'planck';

/** 预设样例标识 */
export type ScenarioId = 'short' | 'long' | 'weighted';

/** 场景静态参数（重建世界时使用） */
export interface ScenarioConfig {
  id: ScenarioId;
  /** 链节数量，3..12 */
  linkCount: number;
  /** 每节矩形短边半宽（米） */
  linkHalfWidth: number;
  /** 每节矩形长边半高（米） */
  linkHalfHeight: number;
  /** 每节密度 kg/m^2（planck 单位） */
  linkDensity: number;
  /** 顶端固定点（世界坐标，y 向上） */
  anchor: Vec2;
  /** 是否在末端挂重物 */
  hasWeight: boolean;
  /** 重物质量 kg（hasWeight 为 true 时生效） */
  weightMass: number;
  /** 重物半径（米） */
  weightRadius: number;
  /** 初始整体倾斜角（弧度），用于产生自然摆动，不使用预制动画 */
  initialLean: number;
}

/** 可在运行中调整的仿真参数 */
export interface SimParams {
  /** 重力加速度大小 m/s^2，方向竖直向下 */
  gravity: number;
  /** 关节角度限制：相对参考角 ±limitAngle（弧度） */
  limitAngle: number;
  /** 是否启用角度限制 */
  limitEnabled: boolean;
  /** 末端重物质量 kg（仅带重物样例有效，下次重置生效） */
  weightMass: number;
  /** 是否按统一规则排除相邻链节碰撞 */
  adjacentFilter: boolean;
}

/** 一条链节的运行时记录 */
export interface LinkRecord {
  /** 链节编号，0 = 最靠近固定端 */
  index: number;
  body: Body;
  /** 矩形半宽/半高（米） */
  halfWidth: number;
  halfHeight: number;
}

/** 一个关节的运行时记录 */
export interface JointRecord {
  /** 关节编号，0 = 固定端与第 0 节之间 */
  index: number;
  /** 物理关节；拆开期间为 null */
  joint: RevoluteJoint | null;
  bodyA: Body;
  bodyB: Body;
  /** 两端各自的本地锚点 */
  localAnchorA: Vec2;
  localAnchorB: Vec2;
  /** 参考相对角（bodyB 角 - bodyA 角） */
  referenceAngle: number;
  /** 是否处于拆开状态 */
  broken: boolean;
  /** true 表示这是末端重物与最后一节之间的关节 */
  isWeightJoint: boolean;
}

/** 静态障碍/地面的记录 */
export interface StaticRecord {
  kind: 'ground' | 'circle';
  body: Body;
}

/** 选中关节的实时读数，供 HUD 与辅助线使用 */
export interface JointReadout {
  index: number;
  broken: boolean;
  /** 当前关节角（相对参考角，弧度） */
  angle: number;
  /** 角度有效范围 [lower, upper]（弧度） */
  lower: number;
  upper: number;
  limitEnabled: boolean;
  /** 两个连接点在世界坐标中的距离偏差（米） */
  anchorDeviation: number;
  /** A 端连接点世界坐标 */
  anchorA: Vec2;
  /** B 端连接点世界坐标 */
  anchorB: Vec2;
  /** 重连所需的距离阈值（米） */
  reconnectThreshold: number;
  /** 当前是否允许重连 */
  canReconnect: boolean;
}

/** 临时拖拽约束的句柄 */
export interface DragHandle {
  joint: Joint;
  targetBody: Body;
}
