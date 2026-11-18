/**
 * 固定常量与三组预设样例。
 * 所有长度单位为米，planck 世界坐标 y 轴向上。
 */
import { Vec2 } from 'planck';
import type { ScenarioConfig, ScenarioId, SimParams } from './types';

/** 物理固定步长（秒）。显示帧率变化时模拟时间保持一致。 */
export const FIXED_DT = 1 / 60;

/** Box2D 速度/位置迭代次数 */
export const VELOCITY_ITERATIONS = 8;
export const POSITION_ITERATIONS = 3;

/** 单帧最多补步子步数，防止卡顿后螺旋死亡（配合丢帧策略） */
export const MAX_STEPS_PER_FRAME = 5;

/** 重连允许的最大连接点距离（米） */
export const RECONNECT_THRESHOLD = 0.25;

/** 鼠标拾取半径（世界单位，米） */
export const PICK_RADIUS = 0.35;

/** 关节拾取半径（米） */
export const JOINT_PICK_RADIUS = 0.4;

/** Mouse joint 最大力系数（相对被拖 body 重量的倍数） */
export const MOUSE_FORCE_FACTOR = 30;

/** 地面顶边 y 坐标 */
export const GROUND_Y = -7.5;

/** 两个静态圆形障碍 */
export const OBSTACLES = [
  { x: -1.6, y: -3.2, radius: 0.9 },
  { x: 1.9, y: -5.4, radius: 0.7 },
] as const;

/** 固定悬挂点 */
export const ANCHOR_POS = new Vec2(0, 5.5);

export const SCENARIOS: Record<ScenarioId, ScenarioConfig> = {
  /** 短摆链：4 节 */
  short: {
    id: 'short',
    linkCount: 4,
    linkHalfWidth: 0.14,
    linkHalfHeight: 0.55,
    linkDensity: 1.2,
    anchor: ANCHOR_POS.clone(),
    hasWeight: false,
    weightMass: 2,
    weightRadius: 0.35,
    initialLean: 0.35,
  },
  /** 长链：10 节 */
  long: {
    id: 'long',
    linkCount: 10,
    linkHalfWidth: 0.1,
    linkHalfHeight: 0.5,
    linkDensity: 1.0,
    anchor: ANCHOR_POS.clone(),
    hasWeight: false,
    weightMass: 2,
    weightRadius: 0.35,
    initialLean: 0.18,
  },
  /** 带重物链：6 节 + 末端重物 */
  weighted: {
    id: 'weighted',
    linkCount: 6,
    linkHalfWidth: 0.12,
    linkHalfHeight: 0.5,
    linkDensity: 1.0,
    anchor: ANCHOR_POS.clone(),
    hasWeight: true,
    weightMass: 4,
    weightRadius: 0.4,
    initialLean: 0.25,
  },
};

export const DEFAULT_PARAMS: SimParams = {
  gravity: 10,
  limitAngle: Math.PI / 4,
  limitEnabled: true,
  weightMass: 4,
  adjacentFilter: true,
};

/** 各参数滑块范围 */
export const PARAM_LIMITS = {
  gravity: { min: 0, max: 25, step: 0.5 },
  limitAngle: { min: 0, max: Math.PI, step: 0.02 },
  weightMass: { min: 0.5, max: 20, step: 0.5 },
} as const;

export const SCENARIO_LABELS: Record<ScenarioId, string> = {
  short: '短摆链（4 节）',
  long: '长链（10 节）',
  weighted: '带重物链（6 节 + 重物）',
};
