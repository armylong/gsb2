import { ArmParams, JointAngles, BaseTransform, PEDESTAL_HEIGHT } from './kinematics';

export const DEFAULT_PARAMS: ArmParams = {
  link1: 0.8,
  link2: 0.7,
  link3: 0.5,
  limits: {
    q1: { min: -170, max: 170 },
    q2: { min: -80, max: 80 },
    q3: { min: -130, max: 130 },
    q4: { min: -130, max: 130 },
  },
};

export const DEFAULT_ANGLES: JointAngles = { q1: 0, q2: 35, q3: -50, q4: 40 };

export const DEFAULT_BASE: BaseTransform = {
  position: { x: 0, y: 0, z: 0 },
  yawDeg: 0,
};

export interface KnownPose {
  id: string;
  name: string;
  description: string;
  angles: JointAngles;
  base: BaseTransform;
}

/**
 * Known poses used for the independent FK verification. Expected end
 * positions are computed at runtime by forwardKinematicsExplicit() (trig
 * derivation) + the rigid base transform, while the "actual" value is read
 * from the three.js world matrix — two completely separate code paths.
 */
export const KNOWN_POSES: KnownPose[] = [
  {
    id: 'straight',
    name: '姿态 1：完全伸直',
    description: 'q2=q3=q4=0，三节连杆共线，末端 = 底座 + (L1+L2+L3, 柱高, 0)',
    angles: { q1: 0, q2: 0, q3: 0, q4: 0 },
    base: { position: { x: 0, y: 0, z: 0 }, yawDeg: 0 },
  },
  {
    id: 'bent',
    name: '姿态 2：平面弯折',
    description: 'q2=30°, q3=-60°, q4=30°，三段方向依次为 30° / -30° / 0°',
    angles: { q1: 0, q2: 30, q3: -60, q4: 30 },
    base: { position: { x: 0, y: 0, z: 0 }, yawDeg: 0 },
  },
  {
    id: 'base-rotated',
    name: '姿态 3：底座旋转 45°',
    description: '底座整体 yaw=45°（关节角保持局部值），世界坐标随刚体变换旋转',
    angles: { q1: 0, q2: 20, q3: 40, q4: -60 },
    base: { position: { x: 0, y: 0, z: 0 }, yawDeg: 45 },
  },
];

export interface DemoScenario {
  id: string;
  name: string;
  description: string;
  target: { x: number; y: number; z: number };
}

/** Demo target positions are given in WORLD coordinates. */
export function buildDemos(totalReach: number): DemoScenario[] {
  return [
    {
      id: 'reachable',
      name: '演示 1：可达目标',
      description: '目标位于工作空间内部，末端应收敛到容差以内',
      target: { x: 1.2, y: PEDESTAL_HEIGHT + 0.45, z: 0.35 },
    },
    {
      id: 'too-far',
      name: '演示 2：超出总长度',
      description: `目标距离 ${(totalReach * 1.6).toFixed(2)}m > 总臂长 ${totalReach.toFixed(2)}m，保持合法姿态并报告残余距离`,
      target: { x: totalReach * 1.6, y: PEDESTAL_HEIGHT + 0.2, z: 0 },
    },
    {
      id: 'limited',
      name: '演示 3：受关节限制',
      description:
        '目标在总长度以内但接近正上方（仰角 ≈ 87°），超出 q2=80° 的俯仰限制，保持合法姿态且无法到达',
      target: { x: 0.1, y: PEDESTAL_HEIGHT + 1.99, z: 0 },
    },
    {
      id: 'cross-side',
      name: '演示 4：连续跨侧拖动',
      description: '目标沿脚本路径从一侧经过底座轴线附近移动到另一侧，观察姿态保持连续、不整臂翻转',
      target: { x: 1.5, y: PEDESTAL_HEIGHT + 0.1, z: 0.9 },
    },
  ];
}
