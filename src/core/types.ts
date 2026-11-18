/** 基础类型定义 —— 世界坐标单位为“格”，x 朝东南、y 朝南、z 朝上。 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 轴对齐长方体占地范围（世界坐标，半开区间 [min, max)）。 */
export interface AABB {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export type EntityId = string;

export interface Block {
  id: EntityId;
  label: string;
  /** 占地左下角（北西角）的格子坐标，可带小数。 */
  x: number;
  y: number;
  /** 底面标高。 */
  z: number;
  /** 占地尺寸（格）。 */
  sx: number;
  sy: number;
  /** 高度（格）。 */
  h: number;
  color: string;
}

export interface Character {
  /** 角色脚底中心的世界坐标（占地 0.6×0.6，高 1.6）。 */
  x: number;
  y: number;
  z: number;
}

export interface Scene {
  blocks: Block[];
  character: Character;
}

export interface Camera {
  /** 世界原点 (0,0,0) 投影后的屏幕坐标（CSS 像素）。 */
  originX: number;
  originY: number;
  /** 每格水平对角线长度的一半，即投影缩放系数。 */
  k: number;
}

export type SortMode = 'correct' | 'naive';
