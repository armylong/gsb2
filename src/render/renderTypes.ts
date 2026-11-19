/** 渲染层共享类型（避免渲染器之间循环依赖） */
import type { Circle as CoreCircle, Poly as CorePoly } from '../core/geometry';

export type Circle = CoreCircle;
export type Poly = CorePoly;

export const ROOM_CONST = { w: 900, h: 600 } as const;
