import type { Cell } from './types';

/**
 * 编辑形状（格坐标集合）。所有形状在生成时即完成越界裁剪：
 * 超出地图的部分直接丢弃，只返回有效格；空洞与实格的区分由调用方
 * 依据当前网格状态判断，形状本身不携带“实心”语义。
 */

export interface CircleSpec {
  /** 圆心格坐标（可为小数，按距离取整格）。 */
  cx: number;
  cy: number;
  /** 半径（格），>= 0。 */
  radius: number;
}

export interface RectSpec {
  /** 矩形任一角的格坐标。 */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 圆形覆盖的格：格中心到圆心距离 <= radius。 */
export function circleCells(spec: CircleSpec): Cell[] {
  const { cx, cy, radius } = spec;
  if (radius < 0) throw new Error('半径不能为负');
  const cells: Cell[] = [];
  const r = Math.ceil(radius);
  const r2 = radius * radius;
  for (let y = Math.floor(cy) - r; y <= Math.ceil(cy) + r; y++) {
    for (let x = Math.floor(cx) - r; x <= Math.ceil(cx) + r; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2 + 1e-9) {
        cells.push({ x, y });
      }
    }
  }
  return cells;
}

/** 轴对齐矩形覆盖的格（含两端）。坐标顺序任意。 */
export function rectCells(spec: RectSpec): Cell[] {
  const minX = Math.min(spec.x0, spec.x1);
  const maxX = Math.max(spec.x0, spec.x1);
  const minY = Math.min(spec.y0, spec.y1);
  const maxY = Math.max(spec.y0, spec.y1);
  const cells: Cell[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      cells.push({ x, y });
    }
  }
  return cells;
}

/** 丢弃越界格，只保留地图内的有效部分。 */
export function clipToBounds(
  cells: readonly Cell[],
  width: number,
  height: number,
): Cell[] {
  return cells.filter((c) => c.x >= 0 && c.y >= 0 && c.x < width && c.y < height);
}
