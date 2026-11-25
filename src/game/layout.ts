import type { Dir, Pose, StationId } from './types';

// 画布逻辑坐标（实际显示按容器缩放 + DPR）
export const VIEW_W = 1000;
export const VIEW_H = 640;

export interface StationLayout {
  id: StationId;
  name: string;
  short: string;
  /** 台面（脚底）坐标 */
  x: number;
  y: number;
  ridgeY: number;
}

export const STATIONS: StationLayout[] = [
  { id: 'north', name: '北岭台', short: '北', x: 500, y: 208, ridgeY: 252 },
  { id: 'west', name: '西坡台', short: '西', x: 158, y: 470, ridgeY: 520 },
  { id: 'east', name: '东崖台', short: '东', x: 842, y: 470, ridgeY: 520 },
];

export const STATION_MAP: Record<StationId, StationLayout> = Object.fromEntries(
  STATIONS.map((s) => [s.id, s]),
) as Record<StationId, StationLayout>;

const SHOULDER_DY = -52;
const EYE_DY = -78;
export const FLAG_R = 38;

export function shoulder(id: StationId): Pose {
  const s = STATION_MAP[id];
  return { x: s.x, y: s.y + SHOULDER_DY };
}

export function eye(id: StationId): Pose {
  const s = STATION_MAP[id];
  return { x: s.x, y: s.y + EYE_DY };
}

/** 八个方向的屏幕向量（y 向下） */
export const DIR_VECTORS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: -1 }, // 0 上
  { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, // 1 右上
  { x: 1, y: 0 }, // 2 右
  { x: Math.SQRT1_2, y: Math.SQRT1_2 }, // 3 右下
  { x: 0, y: 1 }, // 4 下
  { x: -Math.SQRT1_2, y: Math.SQRT1_2 }, // 5 左下
  { x: -1, y: 0 }, // 6 左
  { x: -Math.SQRT1_2, y: -Math.SQRT1_2 }, // 7 左上
];

export const DIR_NAMES = ['上', '右上', '右', '右下', '下', '左下', '左', '左上'];

export function armTarget(id: StationId, dir: Dir): Pose {
  const p = shoulder(id);
  const v = DIR_VECTORS[dir];
  return { x: p.x + v.x * FLAG_R, y: p.y + v.y * FLAG_R };
}

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function dist(a: Pose, b: Pose): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
