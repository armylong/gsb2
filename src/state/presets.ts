import type { Pulley } from '../math/belt';

export interface Preset {
  name: string;
  description: string;
  /** 预期是否有效；仅用于界面提示，实际以 buildBelt 结果为准 */
  valid: boolean;
  pulleys: Pulley[];
}

export const DEFAULT_SPACING = 0.8;
export const DEFAULT_SPEED = 1.2;
export const DEFAULT_STEP = 0.2;

export const PRESETS: Preset[] = [
  {
    name: '默认布置',
    description: '三轮正常贴合，接触弧与直段清晰',
    valid: true,
    pulleys: [
      { center: { x: -4, y: 0 }, radius: 1.2 },
      { center: { x: 0, y: 2.4 }, radius: 0.9 },
      { center: { x: 4, y: 0 }, radius: 1.5 },
    ],
  },
  {
    name: '偏心·包角失效',
    description: '中间轮下移贴近两轮连线，包角低于阈值',
    valid: false,
    pulleys: [
      { center: { x: -4, y: 0 }, radius: 1.2 },
      { center: { x: 0, y: 0.55 }, radius: 0.9 },
      { center: { x: 4, y: 0 }, radius: 1.5 },
    ],
  },
  {
    name: '偏心·直线交叉',
    description: '中间轮几乎与两轮共线，相邻切线在内部交叉',
    valid: false,
    pulleys: [
      { center: { x: -4, y: 0 }, radius: 1.2 },
      { center: { x: 0, y: 0.004 }, radius: 0.9 },
      { center: { x: 4, y: 0 }, radius: 1.5 },
    ],
  },
  {
    name: '两轮距离不足',
    description: '轮 1 与轮 2 实体相交，外切线不存在',
    valid: false,
    pulleys: [
      { center: { x: -4, y: 0 }, radius: 1.2 },
      { center: { x: 0, y: 2.4 }, radius: 0.9 },
      { center: { x: 1.8, y: 1.8 }, radius: 1.5 },
    ],
  },
];

export function clonePulleys(p: Pulley[]): Pulley[] {
  return p.map((x) => ({ center: { ...x.center }, radius: x.radius }));
}
