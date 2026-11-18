/**
 * 模拟领域类型与全局常量。
 * 场景单位为“世界单位”,画布仅做等比缩放。
 */
import type { Vec } from './math';

export const WORLD_W = 30;
export const WORLD_H = 20;
export const MAX_AGENTS = 24;
export const MAX_RECTS = 6;

/** 固定模拟步长(秒),渲染与模拟解耦 */
export const DT = 1 / 30;
/** 静态障碍 ORCA 的预测时长(秒) */
export const TIME_HORIZON_OBS = 1.2;
/** 代理间 ORCA 预测时长会随避障强度在 [0.55, 2.4] 之间变化 */
export const TIME_HORIZON_MIN = 0.55;
export const TIME_HORIZON_MAX = 2.4;
/** 邻近感知半径(世界单位) */
export const NEIGHBOR_DIST = 5.5;
/** 静态障碍感知半径(表面距离,世界单位) */
export const OBS_INFLUENCE = 2.6;
export const ARRIVE_EPS = 0.12;
/** 持续停滞判定:速度低于该值持续 STALL_TIME 秒 */
export const STALL_SPEED = 0.12;
export const STALL_TIME = 3.0;

export type AgentStatus = 'moving' | 'waiting' | 'arrived';

export interface AgentSpec {
  id: number;
  pos: Vec;
  goal: Vec;
  radius: number;
  maxSpeed: number;
  /** 舒适巡航速度,不超过 maxSpeed */
  prefSpeed: number;
  maxAccel: number;
  color: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlapInfo {
  kind: 'agent' | 'rect';
  aId: number;
  bId: number; // rect 索引时使用
  penetration: number; // 正的侵入深度
}

export interface SimStats {
  time: number;
  minSurfaceGap: number; // 全程最小“表面间距”,负值即重叠
  currentMinGap: number;
  arrived: number;
  total: number;
  stalled: number;
  waiting: number;
  maxSpeedObserved: number;
  /** 初始布局重叠(代理间或代理与矩形),非空时布局被暂停 */
  layoutOverlaps: OverlapInfo[];
}

export interface LayoutResult {
  overlaps: OverlapInfo[];
}

export interface PresetDef {
  key: string;
  name: string;
  desc: string;
  timeLimit: number;
  rects: Rect[];
  agents: AgentSpec[];
  /** 该预设是否为“不保证解开”的拥堵对照 */
  stress?: boolean;
}
