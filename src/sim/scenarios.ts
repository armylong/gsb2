/**
 * 三个可直接运行的预设场景.
 * 同一场景在 30/60 两种显示节奏下使用完全相同的初始条件,
 * 仅渲染节流不同, 物理步进固定 (fixedStep), 用于帧率对比.
 */
import type { ClothConfig, SphereState } from './cloth';

export interface Scenario {
  id: string;
  label: string;
  description: string;
  config: ClothConfig;
  sphere: SphereState;
  /** 球体是否参与碰撞 (单角/悬挂场景仍显示球但可忽略) */
  sphereActive: boolean;
  /** 初始相机观察角度 */
  camera: { azimuth: number; polar: number; distance: number };
}

const BASE_GRID = {
  segmentsX: 16,
  segmentsY: 12,
  width: 4,
  height: 3,
  topY: 3,
  iterations: 8,
  drag: 0.08,
};

export const SCENARIOS: Scenario[] = [
  {
    id: 'hanging',
    label: '悬挂 (两角固定)',
    description: '布顶边左右两个角固定, 自然下垂, 无球体接触',
    config: {
      ...BASE_GRID,
      gravity: 9.8,
      stiffness: 0.9,
      // 左上角 (0,0) 与右上角 (0, cols-1)
      pinned: [0, BASE_GRID.segmentsX],
    },
    sphere: { x: 0, y: -2.2, z: 0, radius: 0.9 },
    sphereActive: false,
    camera: { azimuth: 0.6, polar: 1.15, distance: 9.5 },
  },
  {
    id: 'sphere-lift',
    label: '球体托起',
    description:
      '两角固定; 球初始在布后方且无重叠, 拖动球体 Z 滑块向前推入即可观察托起与周围下垂',
    config: {
      ...BASE_GRID,
      gravity: 9.8,
      stiffness: 0.9,
      pinned: [0, BASE_GRID.segmentsX],
    },
    // 零初始重叠: 球在布后方 (z=-2), 半径 1.1, 最近点距布平面 0.9m
    sphere: { x: 0, y: 0.35, z: -2, radius: 1.1 },
    sphereActive: true,
    camera: { azimuth: 0.9, polar: 1.12, distance: 9.5 },
  },
  {
    id: 'single-pin',
    label: '单角固定',
    description: '只固定左上角, 布在重力下绕固定点摆动下垂',
    config: {
      ...BASE_GRID,
      gravity: 9.8,
      stiffness: 0.9,
      pinned: [0],
    },
    sphere: { x: 0, y: -2.2, z: 0, radius: 0.9 },
    sphereActive: false,
    camera: { azimuth: 0.6, polar: 1.15, distance: 9.5 },
  },
];

export function getScenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`未知场景: ${id}`);
  // 深拷贝, 保证多次进入同一预设得到同一组初始条件
  return {
    ...s,
    config: { ...s.config, pinned: [...s.config.pinned] },
    sphere: { ...s.sphere },
    camera: { ...s.camera },
  };
}
