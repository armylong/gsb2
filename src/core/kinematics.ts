/**
 * 铰链门 + 翻板的刚性运动学。
 *
 * 坐标约定 (单位 mm):
 * - 门关闭时门板在 x-z 平面内, 厚度沿 x, 宽度沿 z, 高度沿 y;
 * - 门铰链为过 pivot 的竖直 Y 轴, 向 +z 方向打开 (右手定则, 角度为正);
 * - 托板铰接在门板内表面, 转轴平行于门板局部 X 轴,
 *   收纳时贴在门板上 (局部 -y 侧), 翻下时转到水平姿态。
 *
 * 所有角度对外用弧度。
 */
import {
  type Mat3,
  type OBB,
  type Vec3,
  add,
  makeOBB,
  mulMatVec,
  rotAxis,
} from './math3d';

export type Sequence = 'door-first' | 'tray-first' | 'simultaneous';

export interface DoorSpec {
  /** 门铰链轴位置 (门的竖边中点所在的轴线上一点) */
  pivot: Vec3;
  /** 门板全尺寸 [厚 x, 高 y, 宽 z] */
  size: Vec3;
  /** 打开角范围 [起始, 结束], 弧度 */
  angleRange: [number, number];
}

export interface TraySpec {
  /** 托板铰链在门板局部坐标系中的位置 */
  hingeInDoor: Vec3;
  /** 托板全尺寸 [宽 x, 长 y(展开方向), 厚 z] */
  size: Vec3;
  /** 翻板角范围 [收纳, 翻下], 弧度 */
  angleRange: [number, number];
}

export interface Mechanism {
  door: DoorSpec;
  tray: TraySpec;
  /** 两个转动的先后顺序 */
  sequence: Sequence;
}

export interface Pose {
  t: number;
  doorAngle: number;
  trayAngle: number;
  /** 门板的世界 OBB */
  doorOBB: OBB;
  /** 托板的世界 OBB */
  trayOBB: OBB;
  /** 门板绕世界 Y 轴的姿态矩阵 */
  doorRotation: Mat3;
  /** 托板在门板局部系内的姿态矩阵 */
  trayLocalRotation: Mat3;
  /** 托板铰链的世界坐标 */
  trayHingeWorld: Vec3;
}

/** 单个转动在全局时间 t∈[0,1] 上的进度 */
function phaseProgress(t: number, phase: [number, number]): number {
  if (t <= phase[0]) return 0;
  if (t >= phase[1]) return 1;
  return (t - phase[0]) / (phase[1] - phase[0]);
}

/** 由转动顺序得到门板/托板各自占用的时间区间 (可在 UI 显示) */
export function sequencePhases(sequence: Sequence): { door: [number, number]; tray: [number, number] } {
  switch (sequence) {
    case 'door-first':
      return { door: [0, 0.5], tray: [0.5, 1] };
    case 'tray-first':
      return { door: [0.5, 1], tray: [0, 0.5] };
    case 'simultaneous':
      return { door: [0, 1], tray: [0, 1] };
  }
}

/** 当前时间下两个转动的角度 (线性运动, 时刻即姿态, 与播放速度/帧率无关) */
export function anglesAt(m: Mechanism, t: number): { doorAngle: number; trayAngle: number } {
  const phases = sequencePhases(m.sequence);
  const pd = phaseProgress(t, phases.door);
  const pt = phaseProgress(t, phases.tray);
  return {
    doorAngle: m.door.angleRange[0] + (m.door.angleRange[1] - m.door.angleRange[0]) * pd,
    trayAngle: m.tray.angleRange[0] + (m.tray.angleRange[1] - m.tray.angleRange[0]) * pt,
  };
}

/** 门板在自身局部系 (原点在铰链) 的 OBB: 向 +z 延伸 */
function doorLocalOBB(door: DoorSpec): OBB {
  const center: Vec3 = [0, 0, door.size[2] / 2];
  return makeOBB(center, door.size);
}

export function getPose(m: Mechanism, t: number): Pose {
  const tt = Math.max(0, Math.min(1, t));
  const { doorAngle, trayAngle } = anglesAt(m, tt);

  // 门板: 绕世界 Y 轴
  const doorRotation = rotAxis([0, 1, 0], doorAngle);
  const doorOBB: OBB = {
    center: add(m.door.pivot, mulMatVec(doorRotation, doorLocalOBB(m.door).center)),
    half: doorLocalOBB(m.door).half,
    axes: [
      mulMatVec(doorRotation, [1, 0, 0]),
      mulMatVec(doorRotation, [0, 1, 0]),
      mulMatVec(doorRotation, [0, 0, 1]),
    ],
  };

  // 托板: 先在门板局部系绕局部 X 轴, 再随门旋转
  const trayLocalRotation = rotAxis([1, 0, 0], trayAngle);
  const trayLocalCenter: Vec3 = [
    m.tray.hingeInDoor[0],
    m.tray.hingeInDoor[1] - m.tray.size[1] / 2,
    m.tray.hingeInDoor[2],
  ];
  const trayHingeWorld = add(m.door.pivot, mulMatVec(doorRotation, m.tray.hingeInDoor));
  const trayWorldCenter = add(
    m.door.pivot,
    mulMatVec(doorRotation, trayLocalCenter),
  );
  const trayOBB: OBB = {
    center: trayWorldCenter,
    half: [m.tray.size[0] / 2, m.tray.size[1] / 2, m.tray.size[2] / 2],
    axes: [
      mulMatVec(doorRotation, mulMatVec(trayLocalRotation, [1, 0, 0])),
      mulMatVec(doorRotation, mulMatVec(trayLocalRotation, [0, 1, 0])),
      mulMatVec(doorRotation, mulMatVec(trayLocalRotation, [0, 0, 1])),
    ],
  };

  return {
    t: tt,
    doorAngle,
    trayAngle,
    doorOBB,
    trayOBB,
    doorRotation,
    trayLocalRotation,
    trayHingeWorld,
  };
}

export const rad = (deg: number): number => (deg * Math.PI) / 180;
export const deg = (r: number): number => (r * 180) / Math.PI;
